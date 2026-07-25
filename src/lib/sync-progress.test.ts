import { describe, expect, test } from 'bun:test';
import {
  createSyncProgressReporter,
  formatBytes,
  formatCopyDuration,
  formatEntryOutcome,
  formatLiveLine,
  type ProgressOutput,
} from './sync-progress.js';

describe('formatBytes', () => {
  test('uses B under 1 KB, KB under 1 MB, MB with one decimal under 10 MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(48_000)).toBe('48 KB');
    expect(formatBytes(1_200_000)).toBe('1.2 MB');
  });

  test('uses whole MB from 10 MB and GB with one decimal from 1 GB', () => {
    expect(formatBytes(312_000_000)).toBe('312 MB');
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
  });
});

describe('formatCopyDuration', () => {
  test('shows one decimal below 10s', () => {
    expect(formatCopyDuration(300)).toBe('0.3s');
    expect(formatCopyDuration(2_100)).toBe('2.1s');
  });

  test('falls back to formatDurationMs from 10s', () => {
    expect(formatCopyDuration(65_000)).toBe('1m 5s');
  });
});

describe('formatEntryOutcome', () => {
  test('done carries size and duration when known', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: 312_000_000, durationMs: 2_100 }))
      .toBe('done (312 MB, 2.1s)');
  });

  test('done without measurements is a bare done', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: null, durationMs: null })).toBe('done');
  });

  test('terminal states render as plain words', () => {
    expect(formatEntryOutcome({ kind: 'unchanged' })).toBe('unchanged');
    expect(formatEntryOutcome({ kind: 'skipped' })).toBe('skipped');
    expect(formatEntryOutcome({ kind: 'failed' })).toBe('failed');
    expect(formatEntryOutcome({ kind: 'timed-out' })).toBe('timed out');
  });
});

describe('formatLiveLine', () => {
  test('known total and current bytes render a bar, shared-unit fraction, and speed', () => {
    expect(formatLiveLine({ totalBytes: 312_000_000, currentBytes: 148_000_000, elapsedMs: 1_000 }))
      .toBe('[===>      ]  148/312 MB  148 MB/s');
  });

  test('current bytes without a total render size and speed only', () => {
    expect(formatLiveLine({ totalBytes: null, currentBytes: 48_000_000, elapsedMs: 2_000 }))
      .toBe('48 MB  24 MB/s');
  });

  test('no current bytes (copy-in) renders total and ticking elapsed', () => {
    expect(formatLiveLine({ totalBytes: 312_000_000, currentBytes: null, elapsedMs: 1_800 }))
      .toBe('(312 MB) … 1.8s');
  });

  test('no measurements at all render elapsed only', () => {
    expect(formatLiveLine({ totalBytes: null, currentBytes: null, elapsedMs: 1_800 }))
      .toBe('… 1.8s');
  });

  test('a full bar has no head marker and speed guards zero elapsed', () => {
    expect(formatLiveLine({ totalBytes: 100, currentBytes: 100, elapsedMs: 0 }))
      .toBe('[==========]  100/100 B  0 B/s');
  });
});

function createOutputCapture(isTTY: boolean): { writes: string[]; out: ProgressOutput } {
  const writes: string[] = [];
  return {
    writes,
    out: { isTTY, write: (text): void => { writes.push(text); } },
  };
}

describe('createSyncProgressReporter', () => {
  test('non-TTY output prints the header once and one complete line per entry', () => {
    const { writes, out } = createOutputCapture(false);
    const reporter = createSyncProgressReporter('copy-out', out);
    reporter.startEntry('.config/herdr');
    reporter.finishEntry({ kind: 'done', bytes: 1_200_000, durationMs: 300 });
    reporter.startEntry('.local/bin/herdr');
    reporter.finishEntry({ kind: 'unchanged' });
    expect(writes).toEqual([
      'Saving workspace state:\n',
      '  .config/herdr … done (1.2 MB, 0.3s)\n',
      '  .local/bin/herdr … unchanged\n',
    ]);
  });

  test('copy-in direction uses the restoring header', () => {
    const { writes, out } = createOutputCapture(false);
    const reporter = createSyncProgressReporter('copy-in', out);
    reporter.startEntry('.zsh_history');
    reporter.finishEntry({ kind: 'skipped' });
    expect(writes[0]).toBe('Restoring workspace state:\n');
  });

  test('TTY output opens the entry line immediately and overwrites it on finish', () => {
    const { writes, out } = createOutputCapture(true);
    const reporter = createSyncProgressReporter('copy-out', out);
    reporter.startEntry('.config/herdr');
    reporter.finishEntry({ kind: 'done', bytes: null, durationMs: null });
    expect(writes).toEqual([
      'Saving workspace state:\n',
      '  .config/herdr …',
      '\r\x1b[2K  .config/herdr … done\n',
    ]);
  });

  test('the live ticker renders while a copy runs and stops on finishEntry', async () => {
    const { writes, out } = createOutputCapture(true);
    const reporter = createSyncProgressReporter('copy-out', out);
    reporter.startEntry('.local/bin/herdr');
    reporter.copyStarted({ totalBytes: 100, currentBytes: (): number => 50 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    reporter.finishEntry({ kind: 'done', bytes: 100, durationMs: 50 });
    expect(writes.some((text) => text.includes('50/100 B'))).toBe(true);
    const writesAfterFinish = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(writes.length).toBe(writesAfterFinish);
  });
});
