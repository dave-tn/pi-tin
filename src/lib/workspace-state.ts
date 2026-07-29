import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { containerHomeDir, getWorkspaceStateDir } from './paths.js';
import type { ContainerCopyRunner, ContainerOutputRunner, ContainerSubprocessRunner } from './container.js';
import {
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  copyFromContainer,
  execContainerCommand,
  execContainerCommandOutput,
  isContainerSubprocessTimeout,
  streamFromContainer,
  streamToContainer,
} from './container.js';
import { formatDurationMs } from './duration.js';
import { nativeInstallTargets } from './agents.js';
import type { SyncEntryOutcome, SyncProgressReporter } from './sync-progress.js';
import type { ContainerProfile, Workspace } from './validators.js';

// "Workspace state" is a small set of container-profile-declared paths
// (zoxide DB, shell history, …) that pi-tin snapshots between container
// lives: copied *in* when a fresh container starts, copied *out* when a
// session closes. It is not a live mount — see README → Workspace state.
// The same host tree also backs the *managed workspace-state mounts*
// (native-agent installs, herdr session state — see managedInstallMountPaths
// below), which are live mounts and are never synced here.

export type WorkspaceStateDirection = 'copy-in' | 'copy-out';

// The concrete, ordered filesystem operations that realise a sync in one
// direction. The executor is a thin switch over these; all decision logic
// (path derivation, per-direction recipe, ordering) lives in the planner.
export type WorkspaceStateOp =
  | { kind: 'remove-container-path'; containerPath: string }
  | { kind: 'copy-in'; hostPath: string; containerPath: string; user: string }
  | { kind: 'ensure-host-parent'; hostPath: string }
  | { kind: 'remove-host-path'; hostPath: string }
  | { kind: 'probe-container-path'; containerPath: string }
  | { kind: 'copy-out'; containerPath: string; hostPath: string }
  | { kind: 'promote-temp'; tempPath: string; hostPath: string };

export interface WorkspaceStatePlanInput {
  paths: string[];
  user: string;
  hostStateDir: string;
  direction: WorkspaceStateDirection;
}

export interface WorkspaceStateSyncDependencies {
  run?: ContainerSubprocessRunner | undefined;
  capture?: ContainerOutputRunner | undefined;
  copy?: ContainerCopyRunner | undefined;
  warn?: ((message: string) => void) | undefined;
  report?: SyncProgressReporter | undefined;
}

// Copy-in removes the destination first (stale contents must never survive a
// restore), then streams the snapshot in as a tar extracted by the container
// user — ownership is correct by construction, and the stream avoids
// `container cp`'s slow, erratic copy-in path (see streamToContainer).
// Copy-out copies into a temp sibling and only swaps it into place if the copy
// produced it, so a session that never recreated the source (copy fails)
// leaves the previous snapshot intact rather than destroying it. Copying to a
// fresh temp path also sidesteps the nesting trap without a pre-emptive
// delete. Copy-out probes source existence first: Apple `container cp` can
// wedge on a missing container path, so an absent source must be skipped
// before attempting the copy. Both
// directions are best-effort at execution time — a missing source just yields
// nothing. Ops are grouped per entry so the executor can reason about one
// entry's recipe as a unit, and each op maps to at most one subprocess so a
// timeout can be attributed to that op alone.
export function planWorkspaceStateSync(input: WorkspaceStatePlanInput): WorkspaceStateOp[][] {
  const containerHome = containerHomeDir(input.user);

  return input.paths.map((statePath): WorkspaceStateOp[] => {
    const hostPath = path.join(input.hostStateDir, statePath);
    const containerPath = path.posix.join(containerHome, statePath);

    if (input.direction === 'copy-in') {
      return [
        { kind: 'remove-container-path', containerPath },
        { kind: 'copy-in', hostPath, containerPath, user: input.user },
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

// --- Managed workspace-state mounts -----------------------------------------

/**
 * Home-relative dirs live-mounted into the container from the workspace-state
 * dir: native-agent install dirs (the agents' own auto-updaters write there,
 * and the mount persists every update across container lives with no
 * copying), plus, for herdr workspaces, the server binary's bin dir and the
 * `~/.config/herdr` session/restore state — live so it survives hard kills
 * and wedged runtimes, where a teardown-time snapshot does not. Deduped:
 * `.local/bin` is shared by Claude Code and herdr. Keyed off workspace config
 * (attach/tools), never the per-invocation attach override.
 */
export function managedInstallMountPaths(workspace: Pick<Workspace, 'attach' | 'tools'>): string[] {
  const installDirs = nativeInstallTargets(workspace.tools).flatMap(
    (target) => target.install.persistDirs,
  );
  const herdrDirs = workspace.attach === 'herdr' ? ['.local/bin', '.config/herdr'] : [];
  return [...new Set([...installDirs, ...herdrDirs])];
}

// Overlap in either direction: a workspace_state entry of `.local` reaches
// into the `.local/bin` mount just as surely as an entry of `.local/bin`
// itself. Home-relative paths on both sides; purely lexical.
function statePathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export interface SyncableWorkspaceStatePaths {
  syncable: string[];
  /** Dropped workspace_state paths, each with the managed mount it overlaps. */
  dropped: Array<{ statePath: string; mountPath: string }>;
}

/**
 * The container profile's `workspace_state` paths that may actually sync for
 * this workspace: any path overlapping one of the workspace's managed mounts
 * is dropped. An overlapping path must not sync — the copy-in recipe's root
 * `rm -rf` against a live mount would destroy the host-side contents through
 * virtiofs — and the snapshot would be redundant anyway, since the path
 * already persists via the mount. Callers warn about `dropped`.
 *
 * Takes the workspace rather than a mount list so that every sync call site
 * gets the filter by construction: passing `workspace_state` straight to
 * syncWorkspaceState is not something a caller can do by omission.
 */
export function syncableWorkspaceStatePaths(
  workspace: Pick<Workspace, 'attach' | 'tools'>,
  containerProfile: Pick<ContainerProfile, 'workspace_state'>,
): SyncableWorkspaceStatePaths {
  const managedMountPaths = managedInstallMountPaths(workspace);
  const syncable: string[] = [];
  const dropped: Array<{ statePath: string; mountPath: string }> = [];
  for (const statePath of containerProfile.workspace_state) {
    const mountPath = managedMountPaths.find((mount) => statePathsOverlap(statePath, mount));
    if (mountPath === undefined) {
      syncable.push(statePath);
    } else {
      dropped.push({ statePath, mountPath });
    }
  }
  return { syncable, dropped };
}

/**
 * Host directory backing the managed mount at `~/<relPath>`. Lives inside the
 * workspace-state dir on purpose: pre-mount releases snapshotted the same
 * paths there via copy-out, so existing state seeds the mounts on upgrade.
 */
export function workspaceStateMountDir(workspaceName: string, relPath: string): string {
  return path.join(getWorkspaceStateDir(workspaceName), relPath);
}

/** Effectful sibling: create the mount's host dir before the container starts. */
export function ensureWorkspaceStateMountDir(workspaceName: string, relPath: string): string {
  const mountDir = workspaceStateMountDir(workspaceName, relPath);
  fs.mkdirSync(mountDir, { recursive: true });
  return mountDir;
}

// Best-effort +x on a seeded herdr server binary. Standalone, not inside
// ensureWorkspaceStateMountDir: agent-specific magic in a generic helper
// would fire for Claude's .local/bin too, and the generic name would hide it.
// Unverified insurance (the documented exec-bit variance concerns copy-in;
// these snapshots came from copy-out), kept because herdr is the one binary
// with no installer behind it to self-heal — Claude Code and OpenCode heal
// via the install step's `test -x` probe (see src/lib/agent-install.ts).
export function chmodSeededHerdrBinary(workspaceName: string): void {
  const binaryPath = workspaceStateMountDir(workspaceName, path.join('.local', 'bin', 'herdr'));
  try {
    const stats = fs.statSync(binaryPath);
    if (stats.isFile()) {
      fs.chmodSync(binaryPath, stats.mode | 0o111);
    }
  } catch {
    // No seeded binary — herdr auto-installs its server on first use.
  }
}

// --- Effectful executor (thin switch over the planned ops) ------------------

type ContainerPathShape = 'dir' | 'file' | 'absent';

// One exec round-trip answers both "is it there" and "which copy mechanism",
// so shape costs nothing over the existence check it replaces. Absence stays
// on the *exit status*, as the `test -e` probe this replaces did: an absent
// path must not be reachable through stdout, or noisy container output would
// send a missing path down the `container cp` route, which can wedge (see
// planWorkspaceStateSync) and would cost a deadline plus a warning every
// sync. Untrusted output otherwise: anything unrecognised falls back to
// 'file', whose `container cp` path is correct for every shape and merely
// slower for directories — guessing 'dir' for a real file would fail the copy
// outright.
function probeContainerPathShape(
  containerName: string,
  containerPath: string,
  capture: ContainerOutputRunner | undefined,
): ContainerPathShape {
  const script = 'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else exit 3; fi';
  try {
    const output = execContainerCommandOutput({
      name: containerName,
      user: 'root',
      command: ['sh', '-c', script, 'sh', containerPath],
      capture,
    }).trim();
    return output === 'dir' ? 'dir' : 'file';
  } catch (error) {
    if (isContainerSubprocessTimeout(error)) {
      throw error;
    }
    // Matches the previous probe: a failed existence check skips the entry.
    return 'absent';
  }
}

// Total regular-file bytes under hostPath. Throws when the path is absent or
// unreadable — hostSnapshotBytes below owns the null contract. lstat, regular
// files only — a stat walk would follow symlinks (overcounting targets outside
// the tree, and a symlink loop would hang the progress poll). Contrast
// directorySize further down, which counts symlink sizes for the delete
// preview; this one mirrors what a copy moves.
function regularFileBytes(hostPath: string): number {
  const stats = fs.lstatSync(hostPath);
  if (stats.isFile()) {
    return stats.size;
  }
  if (!stats.isDirectory()) {
    return 0;
  }
  return fs
    .readdirSync(hostPath, { withFileTypes: true })
    .reduce((sum, dirent) => sum + regularFileBytes(path.join(hostPath, dirent.name)), 0);
}

// Total regular-file bytes under hostPath, or null when it is absent. Serves
// two measurement points: copy-in totals and the live poll of the growing
// copy-out temp path, where a mid-copy transient error just yields null for
// that tick. The catch sits here rather than inside the walk on purpose:
// swallowing a mid-tree error per entry would report a confidently wrong
// smaller total, where failing to null reports "unknown". directorySize makes
// the opposite call — an approximate delete preview beats none.
function hostSnapshotBytes(hostPath: string): number | null {
  try {
    return regularFileBytes(hostPath);
  } catch {
    return null;
  }
}

// 'skip-absent' ends the entry's recipe.
type WorkspaceStateOpResult = 'continue' | 'skip-absent';

// Per-entry mutable measurement side-channel threaded through the ops; the
// planner stays pure, this is purely for progress reporting.
interface SyncEntryContext {
  copiedBytes: number | null;
  copyDurationMs: number | null;
  // Copy failures collected during runOpGroup and warned about by
  // syncWorkspaceState after finishEntry closes the TTY entry line — warning
  // mid-entry would render appended to that still-open line.
  copyInFailureOps: WorkspaceStateOp[];
  copyOutFailureOps: WorkspaceStateOp[];
  // Set by probe-container-path; read by copy-out to pick the mechanism.
  copyOutIsDirectory: boolean;
}

interface RunOpOptions {
  containerName: string;
  op: WorkspaceStateOp;
  ctx: SyncEntryContext;
  run: ContainerSubprocessRunner | undefined;
  capture: ContainerOutputRunner | undefined;
  copy: ContainerCopyRunner | undefined;
  report: SyncProgressReporter | undefined;
}

async function runOp(options: RunOpOptions): Promise<WorkspaceStateOpResult> {
  const { containerName, op, ctx } = options;
  switch (op.kind) {
    case 'remove-container-path':
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['rm', '-rf', op.containerPath],
        run: options.run,
      });
      return 'continue';
    case 'copy-in': {
      // Skip cleanly when the host has no snapshot yet (e.g. the workspace's
      // first ever start) rather than attempting a copy that must fail.
      if (!fs.existsSync(op.hostPath)) return 'skip-absent';
      const totalBytes = hostSnapshotBytes(op.hostPath);
      options.report?.copyStarted({ totalBytes, currentBytes: null });
      const startedMs = Date.now();
      await streamToContainer({
        name: containerName,
        hostPath: op.hostPath,
        containerPath: op.containerPath,
        user: op.user,
        timeoutMs: CONTAINER_SUBPROCESS_TIMEOUT_MS,
        run: options.copy,
      });
      ctx.copiedBytes = totalBytes;
      ctx.copyDurationMs = Date.now() - startedMs;
      return 'continue';
    }
    case 'ensure-host-parent':
      fs.mkdirSync(path.dirname(op.hostPath), { recursive: true });
      return 'continue';
    case 'remove-host-path':
      fs.rmSync(op.hostPath, { recursive: true, force: true });
      return 'continue';
    case 'probe-container-path': {
      const shape = probeContainerPathShape(containerName, op.containerPath, options.capture);
      if (shape === 'absent') return 'skip-absent';
      ctx.copyOutIsDirectory = shape === 'dir';
      return 'continue';
    }
    case 'copy-out': {
      options.report?.copyStarted({
        totalBytes: null,
        currentBytes: () => hostSnapshotBytes(op.hostPath),
      });
      const startedMs = Date.now();
      if (ctx.copyOutIsDirectory) {
        await streamFromContainer({
          name: containerName,
          containerPath: op.containerPath,
          hostPath: op.hostPath,
          timeoutMs: CONTAINER_SUBPROCESS_TIMEOUT_MS,
          run: options.copy,
        });
      } else {
        await copyFromContainer({
          name: containerName,
          containerPath: op.containerPath,
          hostPath: op.hostPath,
          timeoutMs: CONTAINER_SUBPROCESS_TIMEOUT_MS,
          run: options.copy,
        });
      }
      ctx.copiedBytes = hostSnapshotBytes(op.hostPath);
      ctx.copyDurationMs = Date.now() - startedMs;
      return 'continue';
    }
    case 'promote-temp':
      // Only swap when the copy actually produced the temp. Not because a
      // failed copy-out leaves no temp — streamFromContainer's mkdir -p runs
      // before the pipeline, so a failed directory copy can leave an
      // existing, possibly partial, temp behind. The previous snapshot
      // survives regardless: runOpGroup returns at the first copy-out error
      // or timeout, so this op never runs in a failing group, and the
      // planner's remove-host-path clears any stale temp before the next
      // attempt's copy-out even starts. That clear is only sound because a
      // timed-out copy leaves nothing writing: the deadline kills the host
      // pipeline's whole process group (see spawnContainerCopy), so there is
      // no surviving extractor to race the unlink and blend two snapshots.
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

// 'entry' — one path's copy blew its deadline (almost always data too large to
// move inside it); the rest of the sync is still worth trying.
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
  if (timedOut.scope === 'runtime') {
    return `Warning: ${detail} — container runtime unresponsive; skipping the rest of this sync.`;
  }
  return `Warning: ${detail} — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).`;
}

// A failed copy-in deserves a warning where other best-effort failures stay
// silent: the recipe's remove has already cleared the container-side copy, so
// a deterministic failure (the ustar limits, a container image without tar)
// would otherwise silently empty this path on every start.
function copyInFailureWarning(workspaceName: string, op: WorkspaceStateOp): string {
  return `Warning: workspace_state copy-in failed for '${workspaceStateOpPath(op)}' in workspace '${workspaceName}' — starting without it (the container-side copy was already cleared). Common causes: a file of 8 GiB or larger or a single path component over 100 characters (ustar limits), or a container image without tar.`;
}

// A failed copy-out is the quieter but more consequential half: nothing is
// destroyed, but this workspace's saved state stops advancing, and the
// auto-stop helper syncs with no reporter at all, so without this warning the
// failure has no surface whatsoever. Directory copy-out streams through tar
// under `set -o pipefail`, so any guest-side non-zero fails the whole entry.
function copyOutFailureWarning(workspaceName: string, op: WorkspaceStateOp): string {
  return `Warning: workspace_state copy-out failed for '${workspaceStateOpPath(op)}' in workspace '${workspaceName}' — the previous snapshot was left intact, so this session's changes to that path are not saved. Common causes: the path vanishing mid-sync, or, for directory copies (streamed through tar), a container image without tar or a file changing while the tree was being archived.`;
}

// Outcome of one entry's op group. Mirrors WorkspaceStateOpResult's
// skip-absent, plus 'failed' (a non-timeout error during copy-out, or a
// warned copy-in failure) and 'timed-out' (carrying which op and its scope,
// for the caller's warning).
type OpGroupResult =
  | { kind: 'completed' }
  | { kind: 'skipped' }
  | { kind: 'failed' }
  | { kind: 'timed-out'; timeout: WorkspaceStateTimeout };

// Run one entry's ops. Non-timeout failures are best-effort per op, except a
// failed copy, which ends the entry in either direction: on copy-out so
// promote-temp can never swap in the partial temp a killed copy may have left
// behind; on copy-in so nothing runs against the incomplete destination. Both
// copy directions collect their failing op for a warning: copy-in because the
// recipe's remove has already cleared the container-side copy, copy-out
// because the workspace's saved state silently stops advancing otherwise.
// Timeouts are classified by the op that hit the deadline: a copy op moves
// real data, so its timeout is entry-scoped — the entry's remaining ops are
// skipped (the deadline kills the host pipeline's whole process group, but
// the container-side tar belongs to the runtime and may still be flushing, so
// later ops must not race it — see streamToContainer) but later entries
// still sync. Every other subprocess runs a near-instant command (probe/rm),
// so its timeout is runtime-scoped and the caller abandons the sync. The
// copy-out probe doubles as a per-entry health check: a genuinely wedged
// runtime costs at most one extra copy deadline before the next probe stops
// the sync.
async function runOpGroup(options: {
  containerName: string;
  group: WorkspaceStateOp[];
  direction: WorkspaceStateDirection;
  ctx: SyncEntryContext;
  run: ContainerSubprocessRunner | undefined;
  capture: ContainerOutputRunner | undefined;
  copy: ContainerCopyRunner | undefined;
  report: SyncProgressReporter | undefined;
}): Promise<OpGroupResult> {
  for (const op of options.group) {
    try {
      const result = await runOp({ ...options, op });
      if (result === 'skip-absent') return { kind: 'skipped' };
    } catch (error) {
      if (isContainerSubprocessTimeout(error)) {
        const scope = op.kind === 'copy-in' || op.kind === 'copy-out' ? 'entry' : 'runtime';
        return { kind: 'timed-out', timeout: { scope, op } };
      }
      if (options.direction === 'copy-out') {
        if (op.kind === 'copy-out') options.ctx.copyOutFailureOps.push(op);
        return { kind: 'failed' };
      }
      if (op.kind === 'copy-in') {
        options.ctx.copyInFailureOps.push(op);
        return { kind: 'failed' };
      }
    }
  }
  return { kind: 'completed' };
}

// Snapshot workspace state in one direction. Best-effort per operation: a
// missing source, a not-yet-created path, or a transient `container` failure
// must never fail the open/close flow — this is convenience state, not
// host-authoritative data.
export async function syncWorkspaceState(
  options: {
    containerName: string;
    workspaceName: string;
    paths: string[];
    user: string;
    direction: WorkspaceStateDirection;
  },
  dependencies: WorkspaceStateSyncDependencies = {},
): Promise<void> {
  if (options.paths.length === 0) return;

  const warn = dependencies.warn ?? defaultWarn;
  const groups = planWorkspaceStateSync({
    paths: options.paths,
    user: options.user,
    hostStateDir: getWorkspaceStateDir(options.workspaceName),
    direction: options.direction,
  });

  for (const [index, group] of groups.entries()) {
    const statePath = options.paths[index];
    if (statePath === undefined) continue;
    dependencies.report?.startEntry(statePath);
    const ctx: SyncEntryContext = {
      copiedBytes: null,
      copyDurationMs: null,
      copyInFailureOps: [],
      copyOutFailureOps: [],
      copyOutIsDirectory: false,
    };
    const result = await runOpGroup({
      containerName: options.containerName,
      group,
      direction: options.direction,
      ctx,
      run: dependencies.run,
      capture: dependencies.capture,
      copy: dependencies.copy,
      report: dependencies.report,
    });
    dependencies.report?.finishEntry(entryOutcome(result, ctx));
    // Deferred until after finishEntry closes the TTY entry line — warning
    // from inside runOpGroup would render appended to that still-open line.
    for (const failedOp of ctx.copyInFailureOps) {
      warn(copyInFailureWarning(options.workspaceName, failedOp));
    }
    for (const failedOp of ctx.copyOutFailureOps) {
      warn(copyOutFailureWarning(options.workspaceName, failedOp));
    }
    if (result.kind === 'timed-out') {
      warn(timeoutWarning(options.workspaceName, options.direction, result.timeout));
      if (result.timeout.scope === 'runtime') return;
    }
  }
}

function entryOutcome(result: OpGroupResult, ctx: SyncEntryContext): SyncEntryOutcome {
  switch (result.kind) {
    case 'completed':
      return { kind: 'done', bytes: ctx.copiedBytes, durationMs: ctx.copyDurationMs };
    case 'skipped':
      return { kind: 'skipped' };
    case 'failed':
      return { kind: 'failed' };
    case 'timed-out':
      return { kind: 'timed-out' };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled op group result: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** A workspace's host snapshot directory and what it occupies on disk. */
export interface WorkspaceStateSnapshot {
  path: string;
  bytes: number;
}

function readEntriesSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Best-effort: an entry that cannot be read — unreadable subtree, or a file
// racing away mid-walk — is skipped, so a damaged snapshot yields an
// undercount for the preview instead of aborting the delete that follows.
function directorySize(dir: string): number {
  const entries = readEntriesSafe(dir);
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // lstat, never stat: a symlink's target may live outside the snapshot,
        // and counting it would overstate what deleting the snapshot frees.
        total += fs.lstatSync(full).size;
      }
    } catch {
      // Skipped, same as an unreadable directory.
    }
  }
  return total;
}

/**
 * The host snapshot for `workspaceName`, or null when the workspace never
 * persisted any state. Callers measure before acting so a delete can show what
 * it is about to destroy — the snapshot is routinely the largest artifact a
 * workspace leaves behind.
 */
export function measureWorkspaceStateSnapshot(workspaceName: string): WorkspaceStateSnapshot | null {
  const dir = getWorkspaceStateDir(workspaceName);
  if (!fs.existsSync(dir)) return null;
  return { path: dir, bytes: directorySize(dir) };
}

export type WorkspaceStateRemoval = 'absent' | 'removed' | 'failed';

/**
 * Remove a workspace's host snapshot. Best-effort like the rest of the snapshot
 * machinery: a failure warns and is reported back, never aborts a delete that
 * has already removed the container and image.
 */
export function removeWorkspaceStateSnapshot(
  snapshot: WorkspaceStateSnapshot | null,
  dependencies: {
    remove?: ((dir: string) => void) | undefined;
    warn?: ((message: string) => void) | undefined;
  } = {},
): WorkspaceStateRemoval {
  if (snapshot === null) return 'absent';

  const remove = dependencies.remove ?? ((dir: string): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  try {
    remove(snapshot.path);
    return 'removed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (dependencies.warn ?? defaultWarn)(
      `Warning: failed to remove workspace state '${snapshot.path}': ${message}`,
    );
    return 'failed';
  }
}
