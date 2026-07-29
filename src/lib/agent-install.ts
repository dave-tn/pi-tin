import path from 'node:path';
import chalk from 'chalk';
import { containerHomeDir } from './paths.js';
import {
  execContainerCommand,
  execContainerCommandWithDeadline,
  isContainerSubprocessAborted,
  isContainerSubprocessTimeout,
} from './container.js';
import { tryWithAgentInstallLock } from './runtime-state.js';
import { formatDurationMs } from './duration.js';
import { CLEAR_LINE } from './sync-progress.js';
import type { NativeInstallTarget } from './agents.js';
import type { ProgressOutput } from './sync-progress.js';

// Native agents install in-container at first open, onto the live host
// mounts that back their install dirs (see managedInstallMountPaths). The
// step runs on every open — started and joined alike — so a failed install
// is retryable without a restart; once the probe finds the agent, opens cost
// one `test -x` per native agent.

// Bounds a legitimately long operation (the Claude download is ~250 MB), not
// a stuck runtime — which is why it lives here and not with container.ts's
// wedge-detection deadlines.
export const AGENT_INSTALL_TIMEOUT_MS = 600_000;

/**
 * In-container `test -x` on the agent's installedPath. 'unavailable' is a
 * probe *timeout* only: the probe runs after the attach probe has already
 * proved exec works, so a timeout is anomalous and must never be answered
 * with a ten-minute install against a runtime that just failed a 5s command.
 * Any other failure reads as 'absent' (the probeContainerPathShape
 * precedent) and self-heals via reinstall.
 */
export type AgentInstallProbe = 'installed' | 'absent' | 'unavailable';

export interface AgentInstallProbeEntry {
  target: NativeInstallTarget;
  probe: AgentInstallProbe;
}

export type AgentInstallPlan =
  | { kind: 'install'; targets: NativeInstallTarget[] }
  | { kind: 'skip'; reason: 'probe-unavailable' | 'nothing-to-install' };

/** Decide what the install step does from the probe results alone. */
export function planAgentInstalls(probes: AgentInstallProbeEntry[]): AgentInstallPlan {
  if (probes.some((entry) => entry.probe === 'unavailable')) {
    return { kind: 'skip', reason: 'probe-unavailable' };
  }
  const targets = probes.filter((entry) => entry.probe === 'absent').map((entry) => entry.target);
  return targets.length === 0
    ? { kind: 'skip', reason: 'nothing-to-install' }
    : { kind: 'install', targets };
}

export interface AgentInstallOptions {
  workspaceName: string;
  containerName: string;
  user: string;
  targets: NativeInstallTarget[];
}

// Seams for everything effectful, so probe classification, lock-held vs
// failure, timeout attribution and the SIGINT abort are testable without
// containers (the WorkspaceStateSyncDependencies pattern).
export interface AgentInstallDeps {
  probe: (installedContainerPath: string) => AgentInstallProbe;
  install: (target: NativeInstallTarget) => Promise<void>;
  tryWithInstallLock: <T>(
    workspaceName: string,
    binary: string,
    fn: () => Promise<T>,
  ) => Promise<T | null>;
  warn: (message: string) => void;
  info: (message: string) => void;
  out: ProgressOutput;
  now: () => number;
}

function defaultDeps(options: AgentInstallOptions): AgentInstallDeps {
  return {
    probe: (installedContainerPath): AgentInstallProbe => {
      try {
        execContainerCommand({
          name: options.containerName,
          user: options.user,
          command: ['test', '-x', installedContainerPath],
        });
        return 'installed';
      } catch (error) {
        return isContainerSubprocessTimeout(error) ? 'unavailable' : 'absent';
      }
    },
    install: async (target): Promise<void> => {
      await execContainerCommandWithDeadline({
        name: options.containerName,
        user: options.user,
        command: ['sh', '-c', target.install.installCommand],
        timeoutMs: AGENT_INSTALL_TIMEOUT_MS,
        // ^C skips the install and continues to the shell — on a host,
        // interrupting an installer returns you to your prompt. The copy
        // path's die-on-interrupt would instead strand a running container
        // with no auto-stop armed, at the most ^C-tempting wait in the flow.
        onInterrupt: 'abort',
      });
    },
    tryWithInstallLock: tryWithAgentInstallLock,
    warn: (message): void => {
      console.warn(chalk.yellow(message));
    },
    info: (message): void => {
      console.log(chalk.dim(message));
    },
    out: process.stdout,
    now: () => Date.now(),
  };
}

const INSTALL_TICK_MS = 1_000;

// There is no byte visibility (the download happens in-container), so elapsed
// time is the only honest progress signal. TTY: the line ticks in place and
// the outcome replaces it. Non-TTY: only the complete outcome line is written
// (no control codes in logs) — the sync-progress convention.
function createInstallTicker(
  name: string,
  out: ProgressOutput,
  startedMs: number,
  now: () => number,
): { finish: (outcome: string) => void } {
  const label = `Installing ${name}`;
  let ticker: ReturnType<typeof setInterval> | null = null;
  if (out.isTTY === true) {
    out.write(`${label} …`);
    ticker = setInterval(() => {
      out.write(`${CLEAR_LINE}${label} … ${formatDurationMs(now() - startedMs)}`);
    }, INSTALL_TICK_MS);
    ticker.unref();
  }
  return {
    finish(outcome): void {
      if (ticker !== null) clearInterval(ticker);
      const line = `${label} … ${outcome}\n`;
      out.write(out.isTTY === true ? `${CLEAR_LINE}${line}` : line);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type InstallOutcome = 'installed' | 'failed' | 'aborted';

/**
 * Probe for and install any missing native agents, best-effort: every failure
 * warns and the open continues agent-less, host-like — the step retries on
 * the next open. Runs with the container up and attach-ready.
 */
export async function runAgentInstallStep(
  options: AgentInstallOptions,
  overrides: Partial<AgentInstallDeps> = {},
): Promise<void> {
  if (options.targets.length === 0) return;
  const deps: AgentInstallDeps = { ...defaultDeps(options), ...overrides };
  const containerHome = containerHomeDir(options.user);

  const probes: AgentInstallProbeEntry[] = [];
  for (const target of options.targets) {
    const probe = deps.probe(path.posix.join(containerHome, target.install.installedPath));
    probes.push({ target, probe });
    // Don't queue more doomed 5s waits against a runtime that just timed out.
    if (probe === 'unavailable') break;
  }

  const plan = planAgentInstalls(probes);
  if (plan.kind === 'skip') {
    if (plan.reason === 'probe-unavailable') {
      deps.warn(
        `Warning: could not check the installed agents in workspace '${options.workspaceName}' (the probe timed out) — skipping agent installs for this open.`,
      );
    }
    return;
  }

  for (const target of plan.targets) {
    const outcome = await installOne(options, deps, target);
    // Lock-held is not a failure: another pi-tin open is installing this
    // agent right now; this open proceeds without it.
    if (outcome === null) {
      deps.info(`Another pi-tin open is installing ${target.name} — continuing without it.`);
      continue;
    }
    // ^C aborts the whole install step, not just this agent — the user asked
    // to stop waiting. The open continues to the shell.
    if (outcome === 'aborted') return;
  }
}

async function installOne(
  options: AgentInstallOptions,
  deps: AgentInstallDeps,
  target: NativeInstallTarget,
): Promise<InstallOutcome | null> {
  try {
    return await withInstallLock(options, deps, target);
  } catch (error) {
    // The lock itself failed (unwritable state dir, disk full) — the one
    // failure outside deps.install's own handling. It gets the same treatment
    // as a failed install rather than escaping: an agent pi-tin could not
    // install must never cost the user their open.
    deps.warn(
      `Warning: could not start the ${target.name} install — continuing without it; pi-tin retries on the next open. ${errorMessage(error)}`,
    );
    return 'failed';
  }
}

async function withInstallLock(
  options: AgentInstallOptions,
  deps: AgentInstallDeps,
  target: NativeInstallTarget,
): Promise<InstallOutcome | null> {
  return await deps.tryWithInstallLock(options.workspaceName, target.binary, async () => {
    const startedMs = deps.now();
    const ticker = createInstallTicker(target.name, deps.out, startedMs, deps.now);
    try {
      await deps.install(target);
      ticker.finish(`done (${formatDurationMs(deps.now() - startedMs)})`);
      return 'installed';
    } catch (error) {
      if (isContainerSubprocessAborted(error)) {
        ticker.finish('aborted');
        deps.warn(`Warning: ${target.name} install aborted — pi-tin retries it on the next open.`);
        return 'aborted';
      }
      if (isContainerSubprocessTimeout(error)) {
        ticker.finish('timed out');
        deps.warn(
          `Warning: ${target.name} install timed out after ${formatDurationMs(AGENT_INSTALL_TIMEOUT_MS)} — continuing without it; pi-tin retries on the next open. The in-container installer may still be running.`,
        );
        return 'failed';
      }
      ticker.finish('failed');
      deps.warn(
        `Warning: ${target.name} install failed — continuing without it; pi-tin retries on the next open. ${errorMessage(error)}`,
      );
      return 'failed';
    }
  });
}
