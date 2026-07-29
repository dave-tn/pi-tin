import { describe, expect, test } from 'bun:test';
import {
  createSyncProgressReporter,
  formatCopyDuration,
  formatEntryOutcome,
  formatLiveLine,
  type ProgressOutput,
} from './sync-progress.js';

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
      .toBe('done (312.0 MB, 2.1s)');
  });

  test('sizes step up through the decimal units', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: 512, durationMs: null })).toBe('done (512 B)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 48_000, durationMs: null })).toBe('done (48.0 KB)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 1_200_000, durationMs: null })).toBe('done (1.2 MB)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 1_400_000_000, durationMs: null })).toBe('done (1.4 GB)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 2_000_000_000_000, durationMs: null })).toBe('done (2.0 TB)');
  });

  // Regression: sync-progress used to carry its own formatBytes, which showed
  // a four-digit mantissa ("1000 KB", "1000 MB") when rounding landed back on
  // the unit threshold. Sharing cli-output's implementation steps up instead.
  test('a size that rounds onto the unit threshold steps up a unit', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: 999_950, durationMs: null })).toBe('done (1.0 MB)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 999_950_000, durationMs: null })).toBe('done (1.0 GB)');
  });

  test('a size just below the rounding threshold keeps its unit', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: 999_949, durationMs: null })).toBe('done (999.9 KB)');
    expect(formatEntryOutcome({ kind: 'done', bytes: 999_949_000, durationMs: null })).toBe('done (999.9 MB)');
  });

  test('done without measurements is a bare done', () => {
    expect(formatEntryOutcome({ kind: 'done', bytes: null, durationMs: null })).toBe('done');
  });

  test('terminal states render as plain words', () => {
    expect(formatEntryOutcome({ kind: 'skipped' })).toBe('skipped');
    expect(formatEntryOutcome({ kind: 'failed' })).toBe('failed');
    expect(formatEntryOutcome({ kind: 'timed-out' })).toBe('timed out');
  });
});

describe('formatLiveLine', () => {
  test('known total and current bytes render a bar, shared-unit fraction, and speed', () => {
    expect(formatLiveLine({ totalBytes: 312_000_000, currentBytes: 148_000_000, elapsedMs: 1_000 }))
      .toBe('[===>      ]  148.0/312.0 MB  148.0 MB/s');
  });

  // The fraction picks its unit from the total, so a barely-started copy still
  // reads against the same scale instead of switching to its own unit.
  test('the fraction stays in the total\'s unit even when current is tiny', () => {
    expect(formatLiveLine({ totalBytes: 999_950, currentBytes: 500, elapsedMs: 1_000 }))
      .toBe('[          ]  0.0/1.0 MB  500 B/s');
  });

  test('current bytes without a total render size and speed only', () => {
    expect(formatLiveLine({ totalBytes: null, currentBytes: 48_000_000, elapsedMs: 2_000 }))
      .toBe('48.0 MB  24.0 MB/s');
  });

  // Regression: the rate formatter shared sync-progress's old formatBytes, so
  // a rate that rounds onto the unit threshold showed "1000 KB/s".
  test('a size and rate that round onto the unit threshold step up a unit', () => {
    expect(formatLiveLine({ totalBytes: null, currentBytes: 999_950, elapsedMs: 1_000 }))
      .toBe('1.0 MB  1.0 MB/s');
    expect(formatLiveLine({ totalBytes: null, currentBytes: 999_950_000, elapsedMs: 1_000 }))
      .toBe('1.0 GB  1.0 GB/s');
  });

  test('a sub-KB rate is rounded to whole bytes rather than shown as a raw float', () => {
    expect(formatLiveLine({ totalBytes: null, currentBytes: 1_000, elapsedMs: 3_000 }))
      .toBe('1.0 KB  333 B/s');
  });

  test('no current bytes (copy-in) renders total and ticking elapsed', () => {
    expect(formatLiveLine({ totalBytes: 312_000_000, currentBytes: null, elapsedMs: 1_800 }))
      .toBe('(312.0 MB) … 1.8s');
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
    reporter.startEntry('.local/share/zoxide');
    reporter.finishEntry({ kind: 'skipped' });
    expect(writes).toEqual([
      'Saving workspace state:\n',
      '  .config/herdr … done (1.2 MB, 0.3s)\n',
      '  .local/share/zoxide … skipped\n',
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

  test('double copyStarted replaces the first ticker without leaking', async () => {
    const { writes, out } = createOutputCapture(true);
    const reporter = createSyncProgressReporter('copy-out', out);
    reporter.startEntry('.config/nested');
    reporter.copyStarted({ totalBytes: 200, currentBytes: (): number => 100 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Ticks before the replacement legitimately render the first source, so
    // only the writes from here on can say which ticker survived.
    const mark = writes.length;
    reporter.copyStarted({ totalBytes: 200, currentBytes: (): number => 150 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    reporter.finishEntry({ kind: 'done', bytes: 200, durationMs: 100 });
    // Every tick after the replacement must read the second progress source.
    // Without this the test only proves "no extra writes after finish", which
    // an implementation that kept the first ticker and dropped the second
    // would also satisfy.
    const afterReplacement = writes.slice(mark);
    expect(afterReplacement.some((text) => text.includes('150/200 B'))).toBe(true);
    expect(afterReplacement.some((text) => text.includes('100/200 B'))).toBe(false);
    const writesAfterFinish = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(writes.length).toBe(writesAfterFinish);
  });
});
