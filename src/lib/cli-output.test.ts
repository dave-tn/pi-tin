import { describe, expect, test } from 'bun:test';
import { resolveJsonMode } from './cli-output.js';

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
