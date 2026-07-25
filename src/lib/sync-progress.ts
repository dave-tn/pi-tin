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
