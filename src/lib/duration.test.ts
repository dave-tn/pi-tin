import { describe, test, expect } from 'bun:test';
import {
  parseDurationMs,
  isValidDuration,
  formatDurationMs,
  formatRemainingDuration,
} from './duration.js';

describe('parseDurationMs', () => {
  test('parses seconds, minutes, and hours', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('5m')).toBe(5 * 60 * 1000);
    expect(parseDurationMs('1h')).toBe(60 * 60 * 1000);
  });

  test('rejects invalid durations', () => {
    expect(() => parseDurationMs('0s')).toThrow();
    expect(() => parseDurationMs('-1s')).toThrow();
    expect(() => parseDurationMs('30')).toThrow();
    expect(() => parseDurationMs('1d')).toThrow();
    expect(() => parseDurationMs('')).toThrow();
  });

  test('rejects amounts too large to represent exactly', () => {
    expect(() => parseDurationMs('9'.repeat(309) + 's')).toThrow();
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
});

describe('formatRemainingDuration', () => {
  test('formats remaining time from a deadline', () => {
    expect(formatRemainingDuration(40_000, 10_000)).toBe('30s');
    expect(formatRemainingDuration(71_000, 10_000)).toBe('1m 1s');
    expect(formatRemainingDuration(10_000, 20_000)).toBe('0s');
  });
});
