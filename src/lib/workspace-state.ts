import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { containerHomeDir, getWorkspaceStateDir } from './paths.js';
import type { ContainerCopyRunner, ContainerOutputRunner, ContainerSubprocessRunner } from './container.js';
import {
  CONTAINER_BINARY_COPY_TIMEOUT_MS,
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  copyFromContainer,
  execContainerCommand,
  execContainerCommandOutput,
  isContainerSubprocessTimeout,
  streamFromContainer,
  streamToContainer,
} from './container.js';
import { formatDurationMs } from './duration.js';
import { nativeAgentInstalls, type NativeStateEntry } from './agents.js';
import type { SyncEntryOutcome, SyncProgressReporter } from './sync-progress.js';
import type { ContainerProfile, Workspace } from './validators.js';

// "Workspace state" is a small set of paths that pi-tin snapshots between
// container lives: copied *in* when a fresh container starts, copied *out* when
// a session closes. It is not a live mount — see README → Workspace state.
// Two kinds of entry share the mechanism: container-profile-declared
// `tool-state` (zoxide DB, shell history, …) and pi-tin-owned `binary` entries
// (persisted agent binaries — the herdr server, native agent installs), which
// carry a larger copy deadline and a changed-check so an unchanged binary
// costs one probe instead of a multi-hundred-MB copy.

export type WorkspaceStateDirection = 'copy-in' | 'copy-out';

export type WorkspaceStateEntry =
  | { kind: 'tool-state'; path: string }
  | ({ kind: 'binary' } & NativeStateEntry);

// The concrete, ordered filesystem operations that realise a sync in one
// direction. The executor is a thin switch over these; all decision logic
// (path derivation, per-direction recipe, ordering) lives in the planner.
export type WorkspaceStateOp =
  | { kind: 'remove-container-path'; containerPath: string }
  | { kind: 'copy-in'; hostPath: string; containerPath: string; user: string; timeoutMs: number }
  | { kind: 'ensure-host-parent'; hostPath: string }
  | { kind: 'remove-host-path'; hostPath: string }
  | { kind: 'probe-container-path'; containerPath: string }
  | { kind: 'probe-unchanged'; containerPath: string; hostPath: string; whenHostMissing: 'skip-entry' | 'continue' }
  | { kind: 'copy-out'; containerPath: string; hostPath: string; timeoutMs: number }
  | { kind: 'promote-temp'; tempPath: string; hostPath: string }
  | { kind: 'restore-executable'; containerPath: string }
  | { kind: 'record-launcher'; linkContainerPath: string; recordHostPath: string }
  | {
      kind: 'restore-launcher';
      linkContainerPath: string;
      versionsDirContainerPath: string;
      versionsDirHostPath: string;
      recordHostPath: string;
      user: string;
    };

// Host-side sibling of a binary entry's snapshot holding the recorded launcher
// target. The launcher symlink itself can never ride `container cp`: copying a
// bare symlink as the source wedges the container (docs/bug-fixing.md).
const LAUNCHER_RECORD_SUFFIX = '.pi-tin-launcher';

export interface WorkspaceStatePlanInput {
  entries: WorkspaceStateEntry[];
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
//
// Binary entries add: a changed-check probe (skipping the expensive copy when
// fingerprints match — on copy-in it runs before remove-container-path so a
// first-ever start never deletes the image-baked binary), a +x restore, and
// launcher record/restore. After an image rebuild bakes a newer binary,
// copy-in restores the older snapshot (fingerprints differ); the agent's own
// updater heals that on its next start — the herdr precedent, no version
// comparison logic.
export function planWorkspaceStateSync(input: WorkspaceStatePlanInput): WorkspaceStateOp[][] {
  const containerHome = containerHomeDir(input.user);

  return input.entries.map((entry): WorkspaceStateOp[] => {
    const hostPath = path.join(input.hostStateDir, entry.path);
    const containerPath = path.posix.join(containerHome, entry.path);
    const timeoutMs =
      entry.kind === 'binary' ? CONTAINER_BINARY_COPY_TIMEOUT_MS : CONTAINER_SUBPROCESS_TIMEOUT_MS;
    const launcher = entry.kind === 'binary' ? entry.launcher : undefined;
    const recordHostPath = `${hostPath}${LAUNCHER_RECORD_SUFFIX}`;
    const ops: WorkspaceStateOp[] = [];

    if (input.direction === 'copy-in') {
      if (entry.kind === 'binary') {
        ops.push({ kind: 'probe-unchanged', containerPath, hostPath, whenHostMissing: 'skip-entry' });
      }
      ops.push(
        { kind: 'remove-container-path', containerPath },
        { kind: 'copy-in', hostPath, containerPath, user: input.user, timeoutMs },
      );
      if (entry.kind === 'binary' && entry.executable) {
        ops.push({ kind: 'restore-executable', containerPath });
      }
      if (launcher !== undefined) {
        ops.push({
          kind: 'restore-launcher',
          linkContainerPath: path.posix.join(containerHome, launcher.link),
          versionsDirContainerPath: path.posix.join(containerHome, launcher.versionsDir),
          versionsDirHostPath: path.join(input.hostStateDir, launcher.versionsDir),
          recordHostPath,
          user: input.user,
        });
      }
      return ops;
    }

    const tempPath = `${hostPath}.pi-tin-tmp`;
    ops.push(
      { kind: 'ensure-host-parent', hostPath },
      { kind: 'remove-host-path', hostPath: tempPath },
      { kind: 'probe-container-path', containerPath },
    );
    if (launcher !== undefined) {
      // Before the changed-check: the recorded target must stay fresh even
      // when the content copy is skipped as unchanged (the updater can swap
      // the link between already-downloaded versions without changing sizes).
      // A copy-out that fails after this leaves the record ahead of the
      // snapshot; restore-launcher resolves against the snapshot's actual
      // contents, so a stale record is harmless.
      ops.push({
        kind: 'record-launcher',
        linkContainerPath: path.posix.join(containerHome, launcher.link),
        recordHostPath,
      });
    }
    if (entry.kind === 'binary') {
      ops.push({ kind: 'probe-unchanged', containerPath, hostPath, whenHostMissing: 'continue' });
    }
    ops.push(
      { kind: 'copy-out', containerPath, hostPath: tempPath, timeoutMs },
      { kind: 'promote-temp', tempPath, hostPath },
    );
    return ops;
  });
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

// --- Fingerprints for the binary changed-check ------------------------------

// Canonical fingerprint: one `<size> <./relative-path>` line per regular file
// (symlinks excluded on both sides), sorted. A single-file entry uses `.` as
// its path. mtimes are useless here — `container cp` does not preserve them.
const FINGERPRINT_LINE = /^\s*(\d+)\s+(\.(?:\/.*)?)$/;

function canonicalFingerprint(pairs: Array<{ relPath: string; size: number }>): string {
  return pairs
    .map(({ relPath, size }) => `${size} ${relPath}`)
    .sort()
    .join('\n');
}

function hostFingerprintPairs(
  hostPath: string,
  relPath: string,
): Array<{ relPath: string; size: number }> {
  const stats = fs.lstatSync(hostPath);
  if (stats.isFile()) {
    return [{ relPath, size: stats.size }];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(hostPath, { withFileTypes: true })
    .flatMap((dirent) =>
      hostFingerprintPairs(
        path.join(hostPath, dirent.name),
        relPath === '.' ? `./${dirent.name}` : `${relPath}/${dirent.name}`,
      ),
    );
}

// Total regular-file bytes under hostPath, or null when it is absent. Serves
// three measurement points: copy-in totals, copy-out done-sizes, and the
// live poll of the growing copy-out temp path (where a mid-copy transient
// error just yields null for that tick).
function hostSnapshotBytes(hostPath: string): number | null {
  try {
    return hostFingerprintPairs(hostPath, '.').reduce((sum, pair) => sum + pair.size, 0);
  } catch {
    return null;
  }
}

/** Host-side fingerprint, or null when the path does not exist. */
export function hostFingerprint(hostPath: string): string | null {
  try {
    const stats = fs.lstatSync(hostPath);
    const pairs = stats.isDirectory()
      ? hostFingerprintPairs(hostPath, '.')
      : stats.isFile()
        ? [{ relPath: '.', size: stats.size }]
        : [];
    return canonicalFingerprint(pairs);
  } catch {
    return null;
  }
}

// Container output is untrusted: parse strictly, and treat any surprise as
// "changed" (null) so the worst a hostile or odd container can cause is an
// unnecessary copy. Timeouts propagate for runtime-scope classification.
export function parseContainerFingerprint(
  output: string,
): { canonical: string; totalBytes: number } | null {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  const pairs: Array<{ relPath: string; size: number }> = [];
  for (const line of lines) {
    const match = FINGERPRINT_LINE.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) {
      // A bare byte count is the single-file `stat -c '%s'` form.
      if (/^\s*\d+\s*$/.test(line)) {
        pairs.push({ relPath: '.', size: Number(line.trim()) });
        continue;
      }
      return null;
    }
    pairs.push({ relPath: match[2], size: Number(match[1]) });
  }
  return {
    canonical: canonicalFingerprint(pairs),
    totalBytes: pairs.reduce((sum, pair) => sum + pair.size, 0),
  };
}

function containerFingerprint(
  containerName: string,
  containerPath: string,
  capture: ContainerOutputRunner | undefined,
): { canonical: string; totalBytes: number } | null {
  // Busybox-portable: per-file `stat -c` lines for a dir, a bare size for a
  // file. stat reads inode metadata only — `wc -c` streams whole file contents,
  // which on busybox blows the 5s probe deadline for multi-hundred-MB binaries
  // and would misread a healthy runtime as wedged.
  const script = 'if [ -d "$1" ]; then cd "$1" && find . -type f -exec stat -c \'%s %n\' {} + ; else stat -c \'%s\' "$1"; fi';
  try {
    const output = execContainerCommandOutput({
      name: containerName,
      user: 'root',
      command: ['sh', '-c', script, 'sh', containerPath],
      capture,
    });
    return parseContainerFingerprint(output);
  } catch (error) {
    if (isContainerSubprocessTimeout(error)) {
      throw error;
    }
    return null;
  }
}

// A recorded launcher target is container-sourced; only its basename is ever
// used, and only when it resolves to a direct, plainly named, non-dot child of
// the versions dir. Anything else means no recorded candidate.
function recordedLauncherBasename(
  recordHostPath: string,
  versionsDirContainerPath: string,
): string | null {
  let target: string;
  try {
    target = fs.readFileSync(recordHostPath, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!target.startsWith(`${versionsDirContainerPath}/`)) return null;
  const base = target.slice(versionsDirContainerPath.length + 1);
  return /^[A-Za-z0-9._-]+$/.test(base) && !/^\.+$/.test(base) ? base : null;
}

// Version binaries the restored snapshot can actually back. Zero-size files
// are the updater's mid-download staging captures — never link to one. A
// truncated-but-nonempty capture is undetectable here; the recorded target is
// preferred exactly because the updater only links complete downloads.
function snapshotVersionBasenames(versionsDirHostPath: string): string[] {
  try {
    return fs
      .readdirSync(versionsDirHostPath, { withFileTypes: true })
      .filter((dirent) => dirent.isFile())
      .map((dirent) => dirent.name)
      .filter((name) => {
        try {
          return fs.statSync(path.join(versionsDirHostPath, name)).size > 0;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// Pick the launcher target from what the just-restored snapshot actually
// holds: the recorded basename when present there, else the newest version
// present, else nothing. Linking (and pruning) only toward a snapshot-backed
// file is what makes a stale record harmless — a copy-out that failed after
// record-launcher leaves the record ahead of the snapshot, and a blind
// restore would create a dangling launcher and then prune the only complete
// binary.
function resolveLauncherBasename(op: {
  recordHostPath: string;
  versionsDirContainerPath: string;
  versionsDirHostPath: string;
}): string | null {
  const versions = snapshotVersionBasenames(op.versionsDirHostPath);
  const recorded = recordedLauncherBasename(op.recordHostPath, op.versionsDirContainerPath);
  if (recorded !== null && versions.includes(recorded)) return recorded;
  const newest = [...versions].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).at(0);
  return newest ?? null;
}

// 'skip-absent'/'skip-unchanged' both end the entry's recipe; they differ
// only in what the progress line reports.
type WorkspaceStateOpResult = 'continue' | 'skip-absent' | 'skip-unchanged';

// Per-entry mutable measurement side-channel threaded through the ops; the
// planner stays pure, this is purely for progress reporting.
interface SyncEntryContext {
  copyOutTotalBytes: number | null;
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
        timeoutMs: op.timeoutMs,
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
    case 'probe-unchanged': {
      const host = hostFingerprint(op.hostPath);
      if (host === null) return op.whenHostMissing === 'skip-entry' ? 'skip-absent' : 'continue';
      const container = containerFingerprint(containerName, op.containerPath, options.capture);
      if (container !== null) ctx.copyOutTotalBytes = container.totalBytes;
      return container !== null && container.canonical === host ? 'skip-unchanged' : 'continue';
    }
    case 'copy-out': {
      options.report?.copyStarted({
        totalBytes: ctx.copyOutTotalBytes,
        currentBytes: () => hostSnapshotBytes(op.hostPath),
      });
      const startedMs = Date.now();
      if (ctx.copyOutIsDirectory) {
        await streamFromContainer({
          name: containerName,
          containerPath: op.containerPath,
          hostPath: op.hostPath,
          timeoutMs: op.timeoutMs,
          run: options.copy,
        });
      } else {
        await copyFromContainer({
          name: containerName,
          containerPath: op.containerPath,
          hostPath: op.hostPath,
          timeoutMs: op.timeoutMs,
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
    case 'restore-executable':
      // `container cp` exec-bit preservation has varied across Apple container
      // releases (see docs/bug-fixing.md); an idempotent chmod is cheap insurance.
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: ['chmod', '+x', op.containerPath],
        run: options.run,
      });
      return 'continue';
    case 'record-launcher':
      try {
        const target = execContainerCommandOutput({
          name: containerName,
          user: 'root',
          command: ['readlink', op.linkContainerPath],
          capture: options.capture,
        }).trim();
        fs.writeFileSync(op.recordHostPath, `${target}\n`);
      } catch (error) {
        if (isContainerSubprocessTimeout(error)) {
          throw error;
        }
        // No launcher to record — drop any stale record so restore stays honest.
        fs.rmSync(op.recordHostPath, { force: true });
      }
      return 'continue';
    case 'restore-launcher': {
      const basename = resolveLauncherBasename(op);
      // No snapshot-backed candidate at all (e.g. an empty or absent versions
      // dir): leave the launcher alone and prune nothing.
      if (basename === null) return 'continue';
      // One subprocess: recreate the launcher symlink at the resolved target
      // and prune every other version — the updater never prunes. The shell
      // only ever sees a target pi-tin built itself from the validated
      // basename, never the raw container-sourced record.
      execContainerCommand({
        name: containerName,
        user: 'root',
        command: [
          'sh',
          '-c',
          'ln -sfn "$1" "$2" && chown -h "$4:$4" "$2" && find "$3" -maxdepth 1 -type f ! -name "$5" -delete',
          'sh',
          `${op.versionsDirContainerPath}/${basename}`,
          op.linkContainerPath,
          op.versionsDirContainerPath,
          op.user,
          basename,
        ],
        run: options.run,
      });
      return 'continue';
    }
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
    case 'probe-unchanged':
    case 'copy-out':
    case 'restore-executable':
      return op.containerPath;
    case 'ensure-host-parent':
    case 'remove-host-path':
    case 'promote-temp':
      return op.hostPath;
    case 'record-launcher':
    case 'restore-launcher':
      return op.linkContainerPath;
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

function opTimeoutMs(op: WorkspaceStateOp): number {
  return op.kind === 'copy-in' || op.kind === 'copy-out'
    ? op.timeoutMs
    : CONTAINER_SUBPROCESS_TIMEOUT_MS;
}

function timeoutWarning(
  workspaceName: string,
  direction: WorkspaceStateDirection,
  timedOut: WorkspaceStateTimeout,
): string {
  const detail = `workspace_state ${direction} timed out after ${formatDurationMs(opTimeoutMs(timedOut.op))} for '${workspaceStateOpPath(timedOut.op)}' in workspace '${workspaceName}'`;
  if (timedOut.scope === 'runtime') {
    return `Warning: ${detail} — container runtime unresponsive; skipping the rest of this sync.`;
  }
  // Entry-scoped timeouts are always copy ops; the binary deadline marks a
  // pi-tin-owned agent-binary entry, where host.mounts advice would not apply.
  return opTimeoutMs(timedOut.op) === CONTAINER_BINARY_COPY_TIMEOUT_MS
    ? `Warning: ${detail} — skipping this path for now; pi-tin retries this agent-binary snapshot on the next open or close.`
    : `Warning: ${detail} — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).`;
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
  return `Warning: workspace_state copy-out failed for '${workspaceStateOpPath(op)}' in workspace '${workspaceName}' — the previous snapshot was left intact, so this session's changes to that path are not saved. Common causes (directories stream through tar): a container image without tar, a file changing while the tree was being archived, or an unreadable or special file under that path.`;
}

// Outcome of one entry's op group. Mirrors WorkspaceStateOpResult's
// skip-absent/skip-unchanged split, plus 'failed' (a non-timeout error during
// copy-out, or a warned copy-in failure) and 'timed-out' (carrying which op
// and its scope, for the caller's warning).
type OpGroupResult =
  | { kind: 'completed' }
  | { kind: 'skipped'; reason: 'absent' | 'unchanged' }
  | { kind: 'failed' }
  | { kind: 'timed-out'; timeout: WorkspaceStateTimeout };

// Run one entry's ops. Non-timeout failures are best-effort per op, except a
// failed copy, which ends the entry in either direction: on copy-out so
// promote-temp can never swap in the partial temp a killed copy may have left
// behind; on copy-in so the restore ops cannot run against the incomplete
// destination, where restore-launcher would retarget the launcher at a
// version that never arrived and prune whatever a partial extraction left
// behind. Both copy directions collect their failing op for a warning:
// copy-in because the recipe's remove has already cleared the container-side
// copy, copy-out because the workspace's saved state silently stops advancing
// otherwise. Timeouts are classified by the op that hit the deadline: a copy
// op moves real data, so its timeout is entry-scoped — the entry's remaining
// ops are skipped (the deadline kills the host pipeline's whole process group,
// but the container-side tar belongs to the runtime and may still be flushing, so
// restore ops must not race it — see streamToContainer) but later entries
// still sync. Every other subprocess runs a near-instant command
// (probe/rm/chmod/readlink/ln), so its timeout is runtime-scoped and the
// caller abandons the sync. The copy-out probe doubles as a per-entry health
// check: a genuinely wedged runtime costs at most one extra copy deadline
// before the next probe stops the sync.
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
      if (result === 'skip-absent') return { kind: 'skipped', reason: 'absent' };
      if (result === 'skip-unchanged') return { kind: 'skipped', reason: 'unchanged' };
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

// Alongside the container profile's own tool-state entries, pi-tin persists
// its own binary entries: for herdr workspaces, ~/.config/herdr
// (session/restore state, needed for restore-and-resume) and ~/.local/bin/herdr
// (the auto-installed server — the rootfs is ephemeral, so without persistence
// every fresh start drops it from PATH and herdr re-prompts to reinstall); and
// for native-install agents (Claude Code, OpenCode), the binaries their own
// auto-updaters maintain, so a fresh start resumes from the last updated
// version instead of reverting to the image bake.
export function combinedWorkspaceStateEntries(
  containerProfile: Pick<ContainerProfile, 'workspace_state'>,
  workspace: Pick<Workspace, 'attach' | 'tools'>,
): WorkspaceStateEntry[] {
  const herdrEntries: WorkspaceStateEntry[] =
    workspace.attach === 'herdr'
      ? [
          { kind: 'tool-state', path: '.config/herdr' },
          { kind: 'binary', path: '.local/bin/herdr', executable: true },
        ]
      : [];
  return [
    ...containerProfile.workspace_state.map(
      (statePath): WorkspaceStateEntry => ({ kind: 'tool-state', path: statePath }),
    ),
    ...herdrEntries,
    ...nativeAgentInstalls(workspace.tools).flatMap((install) =>
      install.stateEntries.map((entry): WorkspaceStateEntry => ({ kind: 'binary', ...entry })),
    ),
  ];
}

// Snapshot workspace state in one direction. Best-effort per operation: a
// missing source, a not-yet-created path, or a transient `container` failure
// must never fail the open/close flow — this is convenience state, not
// host-authoritative data.
export async function syncWorkspaceState(
  options: {
    containerName: string;
    workspaceName: string;
    entries: WorkspaceStateEntry[];
    user: string;
    direction: WorkspaceStateDirection;
  },
  dependencies: WorkspaceStateSyncDependencies = {},
): Promise<void> {
  if (options.entries.length === 0) return;

  const warn = dependencies.warn ?? defaultWarn;
  const groups = planWorkspaceStateSync({
    entries: options.entries,
    user: options.user,
    hostStateDir: getWorkspaceStateDir(options.workspaceName),
    direction: options.direction,
  });

  for (const [index, group] of groups.entries()) {
    const entry = options.entries[index];
    if (entry === undefined) continue;
    dependencies.report?.startEntry(entry.path);
    const ctx: SyncEntryContext = {
      copyOutTotalBytes: null,
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
      return result.reason === 'unchanged' ? { kind: 'unchanged' } : { kind: 'skipped' };
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
