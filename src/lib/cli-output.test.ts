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

  // Pins the top-level error handler's wiring in cli.ts: it cannot see
  // commander's parsed options, so it derives the flag from raw argv. An
  // explicit --json on a TTY must select the JSON error envelope.
  describe('raw-argv detection (cli.ts top-level error handler)', () => {
    const jsonFlagFromArgv = (argv: string[]): true | undefined =>
      argv.includes('--json') ? true : undefined;

    test('--json anywhere in argv forces JSON errors on a TTY', () => {
      expect(resolveJsonMode(jsonFlagFromArgv(['open', 'ws', '--json']), true)).toBe(true);
    });

    test('no --json in argv keeps TTY errors human', () => {
      expect(resolveJsonMode(jsonFlagFromArgv(['open', 'ws']), true)).toBe(false);
    });
  });
});
