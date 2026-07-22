import { execFileSync, spawn } from 'node:child_process';
import * as v from 'valibot';
import {
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  containerNameFor,
  getContainerState,
  stopContainer,
  deleteContainer,
} from './container.js';
import {
  withWorkspaceLock,
  reconcileWorkspaceRuntimeState,
  readShutdown,
  armShutdown,
  clearWorkspaceRuntimeState,
} from './runtime-state.js';
import { planAutoStopDecision, type HerdrAgentStates } from './workspace-plans.js';
import { HerdrAgentListSchema, type ContainerProfile, type Workspace } from './validators.js';
import { loadWorkspace } from './workspaces.js';
import { loadContainerProfile } from './profiles.js';
import { parseDurationMs } from './duration.js';
import { combinedWorkspaceStateEntries, syncWorkspaceState } from './workspace-state.js';
import { removeWorkspaceSshArtifacts } from './ssh-endpoint.js';

// Hidden CLI sentinel used to re-invoke pi-tin as a detached auto-stop helper.
export const AUTO_STOP_COMMAND = '__auto-stop-if-idle';

const MAX_TIMER_MS = 2_147_483_647;

async function sleepUntil(deadlineMs: number): Promise<void> {
  while (true) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(remainingMs, MAX_TIMER_MS));
    });
  }
}

export function spawnAutoStopHelper(workspaceName: string, deadlineMs: number): number | undefined {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return undefined;
  }

  try {
    const child = spawn(process.execPath, [
      scriptPath,
      AUTO_STOP_COMMAND,
      workspaceName,
      String(deadlineMs),
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });

    child.unref();
    return child.pid ?? undefined;
  } catch {
    return undefined;
  }
}

type HerdrAgentListExec = (containerName: string, user: string) => string;

const execHerdrAgentList: HerdrAgentListExec = (containerName, user) =>
  execFileSync('container', [
    'exec',
    '--user',
    user,
    containerName,
    '/bin/sh',
    '-c',
    'herdr agent list',
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

// Any failure (herdr not yet installed, no server running, timeout, unparseable
// output) is 'unavailable' — the planner then stops, which is recoverable via
// herdr's restore-and-resume on the next open.
export function queryHerdrAgentStates(
  containerName: string,
  user: string,
  exec: HerdrAgentListExec = execHerdrAgentList,
): HerdrAgentStates {
  try {
    const agents = v.parse(HerdrAgentListSchema, JSON.parse(exec(containerName, user)));
    return {
      kind: 'states',
      working: agents.filter((agent) => agent.status === 'working').length,
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

type HerdrStopContext =
  | { herdrAttach: false }
  | {
    herdrAttach: true;
    containerProfile: ContainerProfile;
    workspace: Workspace;
    stopAfterMs: number;
  };

// Config may be gone or invalid by the time the detached helper fires; that
// downgrades to the plain non-herdr stop path rather than failing the helper.
function gatherHerdrStopContext(workspaceName: string): HerdrStopContext {
  try {
    const workspace = loadWorkspace(workspaceName);
    if (workspace.attach !== 'herdr') {
      return { herdrAttach: false };
    }
    return {
      herdrAttach: true,
      containerProfile: loadContainerProfile(workspace.profile),
      workspace,
      stopAfterMs: parseDurationMs(workspace.stopAfterLastSession),
    };
  } catch {
    return { herdrAttach: false };
  }
}

export async function runAutoStopHelper(
  workspaceName: string,
  deadlineMs: number,
): Promise<void> {
  await sleepUntil(deadlineMs);

  await withWorkspaceLock(workspaceName, () => {
    const shutdown = readShutdown(workspaceName);
    const runtime = reconcileWorkspaceRuntimeState(workspaceName);
    const containerName = containerNameFor(workspaceName);
    const state = getContainerState(containerName);
    const herdrContext = gatherHerdrStopContext(workspaceName);

    const agentStates: HerdrAgentStates = herdrContext.herdrAttach && state === 'running'
      ? queryHerdrAgentStates(containerName, herdrContext.containerProfile.user)
      : { kind: 'not-applicable' };

    // 'unknown' container state also bails: when listing containers fails, do
    // nothing — never stop or clear state based on an unverified state.
    const plan = planAutoStopDecision({
      containerState: state,
      runtimeState: runtime.runtimeState,
      activeSessions: runtime.activeSessions.length,
      deadlineMatches: shutdown !== null && shutdown.deadlineMs === deadlineMs,
      agentStates,
    });

    if (plan.action === 'bail') {
      return;
    }

    if (plan.action === 'defer') {
      if (!herdrContext.herdrAttach) {
        return;
      }
      const nextDeadlineMs = Date.now() + herdrContext.stopAfterMs;
      const helperPid = spawnAutoStopHelper(workspaceName, nextDeadlineMs);
      armShutdown(workspaceName, {
        armedAt: new Date().toISOString(),
        deadlineMs: nextDeadlineMs,
        helperPid,
      });
      return;
    }

    // herdr agents may have worked (and updated resume state) since the last
    // session's copy-out — snapshot once more so restore-and-resume picks up
    // the latest state. Best-effort like every sync.
    if (herdrContext.herdrAttach) {
      syncWorkspaceState({
        containerName,
        workspaceName,
        entries: combinedWorkspaceStateEntries(herdrContext.containerProfile, herdrContext.workspace),
        user: herdrContext.containerProfile.user,
        direction: 'copy-out',
      });
    }

    // Deliberately not stopAndRemoveContainer: this detached helper runs while holding
    // the workspace lock, so it must stay best-effort — never poll and never throw.
    try {
      stopContainer(containerName);
    } catch {
      // Best effort only.
    }

    const postState = getContainerState(containerName);
    if (postState === 'stopped') {
      try {
        deleteContainer(containerName);
      } catch {
        // Best effort only.
      }
    }

    // Clear only on a confirmed non-running state — an 'unknown' post-state
    // must leave the runtime records for the next invocation to reconcile.
    if (postState === 'stopped' || postState === 'not-found') {
      clearWorkspaceRuntimeState(workspaceName);
      removeWorkspaceSshArtifacts(workspaceName, { clearKnownHosts: false });
    }
  });
}
