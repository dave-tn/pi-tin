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

// "Workspace state" is a small, container-profile-declared set of inert,
// tool-owned paths (zoxide DB, shell history, …) that pi-tin snapshots between
// container lives: copied *in* when a fresh container starts, copied *out* when
// a session closes. It is not a live mount — see WORKSPACE_STATE_PLAN.md.

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
// the nesting trap without a pre-emptive delete. Copy-out also probes source
// existence first: Apple `container cp` can wedge on a missing container path,
// so an absent source must be skipped before attempting the copy. Both
// directions are best-effort at execution time — a missing source just yields
// nothing. Ops are grouped per entry so the executor can reason about one
// entry's recipe as a unit.
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

function runOp(
  containerName: string,
  op: WorkspaceStateOp,
  run: ContainerSubprocessRunner | undefined,
): void {
  switch (op.kind) {
    case 'remove-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['rm', '-rf', op.containerPath],
        run,
      });
      return;
    case 'copy-in':
      // Skip cleanly when the host has no snapshot yet (e.g. the workspace's
      // first ever start) rather than attempting a copy that must fail.
      if (!fs.existsSync(op.hostPath)) return;
      copyToContainer({
        name: containerName,
        hostPath: op.hostPath,
        containerPath: op.containerPath,
        run,
      });
      return;
    case 'chown-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['chown', '-R', `${op.user}:${op.user}`, op.containerPath],
        run,
      });
      return;
    case 'ensure-host-parent':
      fs.mkdirSync(path.dirname(op.hostPath), { recursive: true });
      return;
    case 'remove-host-path':
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      return;
    case 'copy-out':
      if (!containerPathExists(containerName, op.containerPath, run)) return;
      copyFromContainer({
        name: containerName,
        containerPath: op.containerPath,
        hostPath: op.hostPath,
        run,
      });
      return;
    case 'promote-temp':
      // Only swap when the copy actually produced the temp. If copy-out failed,
      // the temp is absent and the previous snapshot is left untouched — a bad
      // session never destroys good state.
      if (!fs.existsSync(op.tempPath)) return;
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      fs.renameSync(op.tempPath, op.hostPath);
      return;
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

function timeoutWarning(
  workspaceName: string,
  direction: WorkspaceStateDirection,
  op: WorkspaceStateOp,
): string {
  return `Warning: workspace_state ${direction} timed out after ${formatDurationMs(CONTAINER_SUBPROCESS_TIMEOUT_MS)} for '${workspaceStateOpPath(op)}' in workspace '${workspaceName}' — skipping the rest of this sync.`;
}

// Run one entry's ops. Non-timeout failures are best-effort per op, except
// during copy-out, which stops at the first error so promote-temp can never
// swap in the partial temp a killed `container cp` may have left behind. A
// timeout means the runtime is likely wedged, so it ends the group (and the
// caller skips the remaining entries) rather than queueing more doomed waits
// — with one exception: after a timed-out copy-in, the chown still runs so
// files a slow copy landed before its deadline never stay root-owned.
// Returns the first op that hit the subprocess deadline, or null.
function runOpGroup(
  containerName: string,
  group: WorkspaceStateOp[],
  direction: WorkspaceStateDirection,
  run: ContainerSubprocessRunner | undefined,
): WorkspaceStateOp | null {
  let timedOutOp: WorkspaceStateOp | null = null;

  for (const op of group) {
    try {
      runOp(containerName, op, run);
    } catch (error) {
      const timedOut = isContainerSubprocessTimeout(error);
      if (timedOut && timedOutOp === null) {
        timedOutOp = op;
      }
      if (direction === 'copy-out') {
        return timedOutOp;
      }
      if (timedOut && op.kind !== 'copy-in') {
        return timedOutOp;
      }
    }
  }

  return timedOutOp;
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
    const timedOutOp = runOpGroup(options.containerName, group, options.direction, dependencies.run);
    if (timedOutOp !== null) {
      warn(timeoutWarning(options.workspaceName, options.direction, timedOutOp));
      return;
    }
  }
}
