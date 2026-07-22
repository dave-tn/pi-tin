import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { containerHomeDir, getWorkspaceStateDir } from './paths.js';
import type { ContainerSubprocessRunner } from './container.js';
import {
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  copyFromContainer,
  copyToContainer,
  execContainerCommand,
  isContainerSubprocessTimeout,
} from './container.js';
import { formatDurationMs } from './duration.js';
import type { ContainerProfile, Workspace } from './validators.js';

// "Workspace state" is a small, container-profile-declared set of inert,
// tool-owned paths (zoxide DB, shell history, …) that pi-tin snapshots between
// container lives: copied *in* when a fresh container starts, copied *out* when
// a session closes. It is not a live mount — see README → Workspace state.

export type WorkspaceStateDirection = 'copy-in' | 'copy-out';

// The concrete, ordered filesystem operations that realise a sync in one
// direction. The executor is a thin switch over these; all decision logic
// (path derivation, per-direction recipe, ordering) lives in the planner.
export type WorkspaceStateOp =
  | { kind: 'remove-container-path'; containerPath: string }
  | { kind: 'copy-in'; hostPath: string; containerPath: string }
  | { kind: 'chown-container-path'; containerPath: string; user: string }
  | { kind: 'ensure-host-parent'; hostPath: string }
  | { kind: 'remove-host-path'; hostPath: string }
  | { kind: 'probe-container-path'; containerPath: string }
  | { kind: 'copy-out'; containerPath: string; hostPath: string }
  | { kind: 'promote-temp'; tempPath: string; hostPath: string };

export interface WorkspaceStatePlanInput {
  entries: string[];
  user: string;
  hostStateDir: string;
  direction: WorkspaceStateDirection;
}

export interface WorkspaceStateSyncDependencies {
  run?: ContainerSubprocessRunner | undefined;
  warn?: ((message: string) => void) | undefined;
}

// Copy-in removes the destination first (avoids `container cp`'s
// existing-directory nesting trap and stale contents), copies, then chowns:
// copied-in files land root-owned and directories keep the host uid, neither
// writable by the container user until fixed. Copy-out copies into a temp
// sibling and only swaps it into place if the copy produced it, so a session
// that never recreated the source (copy fails) leaves the previous snapshot
// intact rather than destroying it. Copying to a fresh temp path also sidesteps
// the nesting trap without a pre-emptive delete. Copy-out probes source
// existence first: Apple `container cp` can wedge on a missing container path,
// so an absent source must be skipped before attempting the copy. Both
// directions are best-effort at execution time — a missing source just yields
// nothing. Ops are grouped per entry so the executor can reason about one
// entry's recipe as a unit, and each op maps to at most one `container`
// subprocess so a timeout can be attributed to that op alone.
export function planWorkspaceStateSync(input: WorkspaceStatePlanInput): WorkspaceStateOp[][] {
  const containerHome = containerHomeDir(input.user);

  return input.entries.map((entry): WorkspaceStateOp[] => {
    const hostPath = path.join(input.hostStateDir, entry);
    const containerPath = path.posix.join(containerHome, entry);

    if (input.direction === 'copy-in') {
      return [
        { kind: 'remove-container-path', containerPath },
        { kind: 'copy-in', hostPath, containerPath },
        { kind: 'chown-container-path', containerPath, user: input.user },
      ];
    }

    const tempPath = `${hostPath}.pi-tin-tmp`;
    return [
      { kind: 'ensure-host-parent', hostPath },
      { kind: 'remove-host-path', hostPath: tempPath },
      { kind: 'probe-container-path', containerPath },
      { kind: 'copy-out', containerPath, hostPath: tempPath },
      { kind: 'promote-temp', tempPath, hostPath },
    ];
  });
}

// --- Effectful executor (thin switch over the planned ops) ------------------

function containerPathExists(
  containerName: string,
  containerPath: string,
  run: ContainerSubprocessRunner | undefined,
): boolean {
  try {
    execContainerCommand({
      name: containerName,
      user: 'root',
      command: ['test', '-e', containerPath],
      run,
    });
    return true;
  } catch (error) {
    if (isContainerSubprocessTimeout(error)) {
      throw error;
    }

    return false;
  }
}

// 'skip-entry' means the rest of this entry's recipe is pointless (its source
// does not exist); every other outcome continues the recipe.
type WorkspaceStateOpResult = 'continue' | 'skip-entry';

function runOp(
  containerName: string,
  op: WorkspaceStateOp,
  run: ContainerSubprocessRunner | undefined,
): WorkspaceStateOpResult {
  switch (op.kind) {
    case 'remove-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['rm', '-rf', op.containerPath],
        run,
      });
      return 'continue';
    case 'copy-in':
      // Skip cleanly when the host has no snapshot yet (e.g. the workspace's
      // first ever start) rather than attempting a copy that must fail.
      if (!fs.existsSync(op.hostPath)) return 'continue';
      copyToContainer({
        name: containerName,
        hostPath: op.hostPath,
        containerPath: op.containerPath,
        run,
      });
      return 'continue';
    case 'chown-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['chown', '-R', `${op.user}:${op.user}`, op.containerPath],
        run,
      });
      return 'continue';
    case 'ensure-host-parent':
      fs.mkdirSync(path.dirname(op.hostPath), { recursive: true });
      return 'continue';
    case 'remove-host-path':
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      return 'continue';
    case 'probe-container-path':
      return containerPathExists(containerName, op.containerPath, run) ? 'continue' : 'skip-entry';
    case 'copy-out':
      copyFromContainer({
        name: containerName,
        containerPath: op.containerPath,
        hostPath: op.hostPath,
        run,
      });
      return 'continue';
    case 'promote-temp':
      // Only swap when the copy actually produced the temp. If copy-out failed,
      // the temp is absent and the previous snapshot is left untouched — a bad
      // session never destroys good state.
      if (!fs.existsSync(op.tempPath)) return 'continue';
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      fs.renameSync(op.tempPath, op.hostPath);
      return 'continue';
    default: {
      // A new WorkspaceStateOp kind must be handled above; this makes the
      // omission a compile error rather than a silently dropped op.
      const _exhaustive: never = op;
      throw new Error(`Unhandled workspace-state op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function workspaceStateOpPath(op: WorkspaceStateOp): string {
  switch (op.kind) {
    case 'remove-container-path':
    case 'copy-in':
    case 'chown-container-path':
    case 'probe-container-path':
    case 'copy-out':
      return op.containerPath;
    case 'ensure-host-parent':
    case 'remove-host-path':
    case 'promote-temp':
      return op.hostPath;
    default: {
      const _exhaustive: never = op;
      throw new Error(`Unhandled workspace-state op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function defaultWarn(message: string): void {
  console.warn(chalk.yellow(message));
}

// 'entry' — one path's copy blew the subprocess deadline (almost always data
// too large to move inside it); the rest of the sync is still worth trying.
// 'runtime' — a near-instant command blew the deadline, so the container
// runtime itself looks unresponsive and further attempts would just queue more
// doomed waits.
interface WorkspaceStateTimeout {
  scope: 'entry' | 'runtime';
  op: WorkspaceStateOp;
}

function timeoutWarning(
  workspaceName: string,
  direction: WorkspaceStateDirection,
  timedOut: WorkspaceStateTimeout,
): string {
  const detail = `workspace_state ${direction} timed out after ${formatDurationMs(CONTAINER_SUBPROCESS_TIMEOUT_MS)} for '${workspaceStateOpPath(timedOut.op)}' in workspace '${workspaceName}'`;
  return timedOut.scope === 'runtime'
    ? `Warning: ${detail} — container runtime unresponsive; skipping the rest of this sync.`
    : `Warning: ${detail} — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).`;
}

// Run one entry's ops. Non-timeout failures are best-effort per op, except
// during copy-out, which stops at the first error so promote-temp can never
// swap in the partial temp a killed `container cp` may have left behind.
// Timeouts are classified by the op that hit the deadline: a `container cp`
// moves real data, so its timeout is entry-scoped — this path is skipped but
// later entries still sync (after a timed-out copy-in the chown still runs so
// files a slow copy landed never stay root-owned). Every other subprocess is a
// `container exec` of a near-instant command (probe/rm/chown), so its timeout
// is runtime-scoped and the caller abandons the sync. The copy-out probe
// doubles as a per-entry health check: a genuinely wedged runtime costs at
// most one extra copy deadline before the next probe stops the sync.
function runOpGroup(
  containerName: string,
  group: WorkspaceStateOp[],
  direction: WorkspaceStateDirection,
  run: ContainerSubprocessRunner | undefined,
): WorkspaceStateTimeout | null {
  let entryTimeout: WorkspaceStateTimeout | null = null;

  for (const op of group) {
    try {
      if (runOp(containerName, op, run) === 'skip-entry') return entryTimeout;
    } catch (error) {
      if (!isContainerSubprocessTimeout(error)) {
        if (direction === 'copy-out') return entryTimeout;
        continue;
      }
      if (op.kind !== 'copy-in' && op.kind !== 'copy-out') {
        return { scope: 'runtime', op };
      }
      entryTimeout = { scope: 'entry', op };
      if (op.kind === 'copy-out') return entryTimeout;
    }
  }

  return entryTimeout;
}

// herdr workspaces sync two extra paths alongside the container profile's own
// entries: ~/.config/herdr (session/restore state, needed for
// restore-and-resume) and ~/.local/bin/herdr (the auto-installed server). The
// rootfs is ephemeral, so without persisting the server binary every fresh
// start drops it from PATH and herdr re-prompts to reinstall (~10MB). The
// binary is the one this host's client installed, so it stays version-matched;
// a host client upgrade re-prompts once and re-snapshots.
export function combinedWorkspaceStateEntries(
  containerProfile: Pick<ContainerProfile, 'workspace_state'>,
  workspace: Pick<Workspace, 'attach'>,
): string[] {
  return [
    ...containerProfile.workspace_state,
    ...(workspace.attach === 'herdr' ? ['.config/herdr', '.local/bin/herdr'] : []),
  ];
}

// Apple `container cp` does not preserve the executable bit: copy-out normalises
// the host snapshot to 0644, so a copied-in herdr server lands non-executable
// and herdr treats it as absent — re-prompting to reinstall on every fresh
// start. Re-apply +x after copy-in for herdr workspaces. Best-effort like the
// sync itself; a failure just means herdr reinstalls, the pre-persistence
// behaviour.
export function restoreHerdrServerExecutable(
  options: {
    containerName: string;
    workspace: Pick<Workspace, 'attach'>;
    user: string;
  },
  dependencies: { run?: ContainerSubprocessRunner | undefined } = {},
): void {
  if (options.workspace.attach !== 'herdr') return;

  const herdrPath = path.posix.join(containerHomeDir(options.user), '.local/bin/herdr');
  try {
    execContainerCommand({
      name: options.containerName,
      user: 'root',
      command: ['chmod', '+x', herdrPath],
      run: dependencies.run,
    });
  } catch {
    // Best effort only.
  }
}

// Snapshot workspace state in one direction. Best-effort per operation: a
// missing source, a not-yet-created path, or a transient `container` failure
// must never fail the open/close flow — this is convenience state, not
// host-authoritative data.
export function syncWorkspaceState(
  options: {
    containerName: string;
    workspaceName: string;
    entries: string[];
    user: string;
    direction: WorkspaceStateDirection;
  },
  dependencies: WorkspaceStateSyncDependencies = {},
): void {
  if (options.entries.length === 0) return;

  const warn = dependencies.warn ?? defaultWarn;
  const groups = planWorkspaceStateSync({
    entries: options.entries,
    user: options.user,
    hostStateDir: getWorkspaceStateDir(options.workspaceName),
    direction: options.direction,
  });

  for (const group of groups) {
    const timedOut = runOpGroup(options.containerName, group, options.direction, dependencies.run);
    if (timedOut === null) continue;
    warn(timeoutWarning(options.workspaceName, options.direction, timedOut));
    if (timedOut.scope === 'runtime') return;
  }
}
