import fs from 'node:fs';
import path from 'node:path';
import { containerHomeDir, getWorkspaceStateDir } from './paths.js';
import { copyFromContainer, copyToContainer, execContainerCommand } from './container.js';

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
  | { kind: 'copy-out'; containerPath: string; hostPath: string };

export interface WorkspaceStatePlanInput {
  entries: string[];
  user: string;
  hostStateDir: string;
  direction: WorkspaceStateDirection;
}

// Copy-in removes the destination first (avoids `container cp`'s
// existing-directory nesting trap and stale contents), copies, then chowns:
// copied-in files land root-owned and directories keep the host uid, neither
// writable by the container user until fixed. Copy-out mirrors the file back to
// the host, replacing any previous snapshot. Both are best-effort at execution
// time — a missing source just yields nothing.
export function planWorkspaceStateSync(input: WorkspaceStatePlanInput): WorkspaceStateOp[] {
  const containerHome = containerHomeDir(input.user);

  return input.entries.flatMap((entry): WorkspaceStateOp[] => {
    const hostPath = path.join(input.hostStateDir, entry);
    const containerPath = path.posix.join(containerHome, entry);

    if (input.direction === 'copy-in') {
      return [
        { kind: 'remove-container-path', containerPath },
        { kind: 'copy-in', hostPath, containerPath },
        { kind: 'chown-container-path', containerPath, user: input.user },
      ];
    }

    return [
      { kind: 'ensure-host-parent', hostPath },
      { kind: 'remove-host-path', hostPath },
      { kind: 'copy-out', containerPath, hostPath },
    ];
  });
}

// --- Effectful executor (thin switch over the planned ops) ------------------

function runOp(containerName: string, op: WorkspaceStateOp): void {
  switch (op.kind) {
    case 'remove-container-path':
      execContainerCommand({ name: containerName, user: 'root', command: ['rm', '-rf', op.containerPath] });
      return;
    case 'copy-in':
      // Skip cleanly when the host has no snapshot yet (e.g. the workspace's
      // first ever start) rather than attempting a copy that must fail.
      if (!fs.existsSync(op.hostPath)) return;
      copyToContainer(containerName, op.hostPath, op.containerPath);
      return;
    case 'chown-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['chown', '-R', `${op.user}:${op.user}`, op.containerPath],
      });
      return;
    case 'ensure-host-parent':
      fs.mkdirSync(path.dirname(op.hostPath), { recursive: true });
      return;
    case 'remove-host-path':
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      return;
    case 'copy-out':
      copyFromContainer(containerName, op.containerPath, op.hostPath);
      return;
  }
}

// Snapshot workspace state in one direction. Best-effort per operation: a
// missing source, a not-yet-created path, or a transient `container` failure
// must never fail the open/close flow — this is convenience state, not
// host-authoritative data.
export function syncWorkspaceState(options: {
  containerName: string;
  workspaceName: string;
  entries: string[];
  user: string;
  direction: WorkspaceStateDirection;
}): void {
  if (options.entries.length === 0) return;

  const ops = planWorkspaceStateSync({
    entries: options.entries,
    user: options.user,
    hostStateDir: getWorkspaceStateDir(options.workspaceName),
    direction: options.direction,
  });

  for (const op of ops) {
    try {
      runOp(options.containerName, op);
    } catch {
      // Best-effort only.
    }
  }
}
