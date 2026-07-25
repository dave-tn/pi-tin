import type { WorkspaceStateDirection } from './workspace-state.js';
import { formatDurationMs } from './duration.js';

// How a workspace-state entry's sync ended, as shown to the user. bytes and
// durationMs are null when the copy never ran or could not be measured.
export type SyncEntryOutcome =
  | { kind: 'done'; bytes: number | null; durationMs: number | null }
  | { kind: 'unchanged' }
  | { kind: 'skipped' }
  | { kind: 'failed' }
  | { kind: 'timed-out' };

// Decimal units to match how Finder and `container` report sizes.
const BYTE_UNITS = [
  { limit: 1_000, divisor: 1, suffix: 'B', decimals: 0 },
  { limit: 1_000_000, divisor: 1_000, suffix: 'KB', decimals: 0 },
  { limit: 10_000_000, divisor: 1_000_000, suffix: 'MB', decimals: 1 },
  { limit: 1_000_000_000, divisor: 1_000_000, suffix: 'MB', decimals: 0 },
  { limit: Number.POSITIVE_INFINITY, divisor: 1_000_000_000, suffix: 'GB', decimals: 1 },
] as const;

function byteUnitFor(bytes: number): (typeof BYTE_UNITS)[number] {
  for (const unit of BYTE_UNITS) {
    if (bytes < unit.limit) {
      return unit;
    }
  }
  return BYTE_UNITS[4];
}

function scaleBytes(bytes: number, unit: (typeof BYTE_UNITS)[number]): string {
  return (bytes / unit.divisor).toFixed(unit.decimals);
}

export function formatBytes(bytes: number): string {
  const unit = byteUnitFor(bytes);
  return `${scaleBytes(bytes, unit)} ${unit.suffix}`;
}

export function formatCopyDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatDurationMs(ms);
}

export function formatEntryOutcome(outcome: SyncEntryOutcome): string {
  switch (outcome.kind) {
    case 'done': {
      const parts = [
        ...(outcome.bytes === null ? [] : [formatBytes(outcome.bytes)]),
        ...(outcome.durationMs === null ? [] : [formatCopyDuration(outcome.durationMs)]),
      ];
      return parts.length === 0 ? 'done' : `done (${parts.join(', ')})`;
    }
    case 'unchanged':
      return 'unchanged';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'timed-out':
      return 'timed out';
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled sync outcome: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

const BAR_WIDTH = 10;

function progressBar(fraction: number): string {
  const filled = Math.min(Math.max(Math.floor(fraction * BAR_WIDTH), 0), BAR_WIDTH);
  const head = filled > 0 && filled < BAR_WIDTH ? '>' : '';
  const solid = '='.repeat(head === '' ? filled : filled - 1);
  return `[${`${solid}${head}`.padEnd(BAR_WIDTH)}]`;
}

function speedPerSecond(bytes: number, elapsedMs: number): string {
  const perSecond = elapsedMs > 0 ? (bytes / elapsedMs) * 1000 : 0;
  return `${formatBytes(perSecond)}/s`;
}

// One in-flight line. Copy-out with a known total gets the bar; copy-out
// without one gets bytes + speed; copy-in (no visible byte count — the tar
// extracts inside the container) gets total + ticking elapsed.
export function formatLiveLine(state: {
  totalBytes: number | null;
  currentBytes: number | null;
  elapsedMs: number;
}): string {
  if (state.currentBytes !== null && state.totalBytes !== null) {
    const unit = byteUnitFor(state.totalBytes);
    const fraction = state.totalBytes > 0 ? state.currentBytes / state.totalBytes : 1;
    return `${progressBar(fraction)}  ${scaleBytes(state.currentBytes, unit)}/${scaleBytes(state.totalBytes, unit)} ${unit.suffix}  ${speedPerSecond(state.currentBytes, state.elapsedMs)}`;
  }
  if (state.currentBytes !== null) {
    return `${formatBytes(state.currentBytes)}  ${speedPerSecond(state.currentBytes, state.elapsedMs)}`;
  }
  const elapsed = `… ${formatCopyDuration(state.elapsedMs)}`;
  return state.totalBytes === null ? elapsed : `(${formatBytes(state.totalBytes)}) ${elapsed}`;
}

// Executor-side view of one in-flight copy: the total when a probe supplied
// it, and a live byte count when the destination is host-visible (copy-out
// polls the growing temp path; copy-in has none).
export interface SyncCopyProgress {
  totalBytes: number | null;
  currentBytes: (() => number | null) | null;
}

export interface SyncProgressReporter {
  startEntry(entryPath: string): void;
  copyStarted(progress: SyncCopyProgress): void;
  finishEntry(outcome: SyncEntryOutcome): void;
}

export interface ProgressOutput {
  isTTY: boolean | undefined;
  write(text: string): void;
}

const LIVE_TICK_MS = 200;
const CLEAR_LINE = '\r\x1b[2K';

const DIRECTION_HEADER: Record<WorkspaceStateDirection, string> = {
  'copy-in': 'Restoring workspace state:',
  'copy-out': 'Saving workspace state:',
};

// Thin writer over the pure formatters. TTY: the entry line opens without a
// newline, live ticks overwrite it in place, and the final outcome replaces
// it. Non-TTY: only complete outcome lines are written (no control codes in
// logs). Interval ticks re-stat the copy-out temp path — cheap next to the
// copy itself.
export function createSyncProgressReporter(
  direction: WorkspaceStateDirection,
  out: ProgressOutput = process.stdout,
): SyncProgressReporter {
  let headerPrinted = false;
  let entryPath = '';
  let entryStartedMs = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const stopTicker = (): void => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };

  return {
    startEntry(path): void {
      if (!headerPrinted) {
        out.write(`${DIRECTION_HEADER[direction]}\n`);
        headerPrinted = true;
      }
      entryPath = path;
      entryStartedMs = Date.now();
      if (out.isTTY === true) out.write(`  ${entryPath} …`);
    },
    copyStarted(progress): void {
      if (out.isTTY !== true) return;
      ticker = setInterval(() => {
        const live = formatLiveLine({
          totalBytes: progress.totalBytes,
          currentBytes: progress.currentBytes === null ? null : progress.currentBytes(),
          elapsedMs: Date.now() - entryStartedMs,
        });
        out.write(`${CLEAR_LINE}  ${entryPath}  ${live}`);
      }, LIVE_TICK_MS);
    },
    finishEntry(outcome): void {
      stopTicker();
      const line = `  ${entryPath} … ${formatEntryOutcome(outcome)}\n`;
      out.write(out.isTTY === true ? `${CLEAR_LINE}${line}` : line);
    },
  };
}
