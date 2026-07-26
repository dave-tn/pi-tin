import { describe, expect, test } from 'bun:test';
import { formatBytes, resolveJsonMode } from './cli-output.js';

describe('formatBytes', () => {
  test('reports small sizes in whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  test('steps up through decimal units with one decimal place', () => {
    expect(formatBytes(1_000)).toBe('1.0 KB');
    expect(formatBytes(259_400_000)).toBe('259.4 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });

  test('bumps to the next unit when rounding would show 1000.0', () => {
    expect(formatBytes(999_950)).toBe('1.0 MB');
    expect(formatBytes(999_949)).toBe('999.9 KB');
  });

  test('the TB cap has no next unit, so its mantissa may reach four digits', () => {
    expect(formatBytes(999_950_000_000_000)).toBe('1000.0 TB');
  });
});

describe('resolveJsonMode', () => {
  test('explicit --json forces JSON even on a TTY', () => {
    expect(resolveJsonMode(true, true)).toBe(true);
  });

  test('non-TTY (captured output) defaults to JSON', () => {
    expect(resolveJsonMode(undefined, false)).toBe(true);
    expect(resolveJsonMode(false, false)).toBe(true);
  });

  test('interactive TTY without --json stays human', () => {
    expect(resolveJsonMode(undefined, true)).toBe(false);
    expect(resolveJsonMode(false, true)).toBe(false);
  });
});
