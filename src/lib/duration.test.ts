import { describe, test, expect } from 'bun:test';
import {
  parseDurationMs,
  isValidDuration,
  formatDurationMs,
  formatRemainingDuration,
  remainingDurationMs,
} from './duration.js';

describe('parseDurationMs', () => {
  test('parses seconds, minutes, and hours', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('5m')).toBe(5 * 60 * 1000);
    expect(parseDurationMs('1h')).toBe(60 * 60 * 1000);
  });

  test('rejects invalid durations, echoing the value and the accepted forms', () => {
    expect(() => parseDurationMs('0s'))
      .toThrow("Invalid duration '0s'. Use values like 30s, 5m, or 1h.");
    expect(() => parseDurationMs('-1s'))
      .toThrow("Invalid duration '-1s'. Use values like 30s, 5m, or 1h.");
    expect(() => parseDurationMs('30'))
      .toThrow("Invalid duration '30'. Use values like 30s, 5m, or 1h.");
    expect(() => parseDurationMs('1d'))
      .toThrow("Invalid duration '1d'. Use values like 30s, 5m, or 1h.");
    expect(() => parseDurationMs(''))
      .toThrow("Invalid duration ''. Use values like 30s, 5m, or 1h.");
  });

  test('rejects amounts too large to represent exactly', () => {
    const tooLarge = '9'.repeat(309) + 's';
    expect(() => parseDurationMs(tooLarge))
      .toThrow(`Invalid duration '${tooLarge}'. Use values like 30s, 5m, or 1h.`);
  });
});

describe('isValidDuration', () => {
  test('matches the parser', () => {
    expect(isValidDuration('30s')).toBe(true);
    expect(isValidDuration('5m')).toBe(true);
    expect(isValidDuration('0s')).toBe(false);
    expect(isValidDuration('10d')).toBe(false);
  });
});

describe('formatDurationMs', () => {
  test('formats short durations', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(1000)).toBe('1s');
    expect(formatDurationMs(30_000)).toBe('30s');
  });

  test('formats minute and hour durations', () => {
    expect(formatDurationMs(61_000)).toBe('1m 1s');
    expect(formatDurationMs(60 * 60 * 1000)).toBe('1h');
    expect(formatDurationMs((60 * 60 + 60) * 1000)).toBe('1h 1m');
  });

  // Sub-second remainders round up: this renders a countdown, and "0s" for a
  // deadline that has not passed reads as expired. A floor would print '0s'.
  test('rounds a part-second up to a whole second', () => {
    expect(formatDurationMs(1)).toBe('1s');
    expect(formatDurationMs(500)).toBe('1s');
    expect(formatDurationMs(1_500)).toBe('2s');
  });

  test('drops the seconds component once hours are shown', () => {
    expect(formatDurationMs(3_601_000)).toBe('1h');
    expect(formatDurationMs((60 * 60 + 59) * 1000)).toBe('1h');
    expect(formatDurationMs((2 * 60 * 60 + 30 * 60 + 59) * 1000)).toBe('2h 30m');
  });
});

describe('remainingDurationMs', () => {
  test('returns milliseconds until the deadline, clamped at zero', () => {
    expect(remainingDurationMs(40_000, 10_000)).toBe(30_000);
    expect(remainingDurationMs(10_000, 20_000)).toBe(0);
  });
});

describe('formatRemainingDuration', () => {
  test('formats remaining time from a deadline', () => {
    expect(formatRemainingDuration(40_000, 10_000)).toBe('30s');
    expect(formatRemainingDuration(71_000, 10_000)).toBe('1m 1s');
    expect(formatRemainingDuration(10_000, 20_000)).toBe('0s');
  });
});
