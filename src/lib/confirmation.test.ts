import { describe, expect, test } from 'bun:test';
import { planConfirmation, confirmDestructive, ensureInteractive } from './confirmation.js';
import { CliError, EXIT } from './cli-errors.js';

describe('planConfirmation', () => {
  test('force always proceeds, even non-interactive', () => {
    expect(planConfirmation({ force: true, isInteractive: false })).toEqual({ kind: 'proceed' });
    expect(planConfirmation({ force: true, isInteractive: true })).toEqual({ kind: 'proceed' });
  });

  test('interactive without force prompts', () => {
    expect(planConfirmation({ force: false, isInteractive: true })).toEqual({ kind: 'prompt' });
  });

  test('non-interactive without force refuses', () => {
    expect(planConfirmation({ force: false, isInteractive: false })).toEqual({ kind: 'refuse' });
  });
});

describe('confirmDestructive', () => {
  test('force proceeds without touching the prompt', async () => {
    expect(
      await confirmDestructive({ message: 'go?', action: "delete x", force: true, isInteractive: false }),
    ).toBe(true);
  });

  test('non-interactive without force throws exit-4 CliError', async () => {
    try {
      await confirmDestructive({ message: 'go?', action: "delete agent profile 'x'", force: false, isInteractive: false });
      throw new Error('expected confirmDestructive to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr: CliError = err instanceof CliError ? err : (() => { throw err; })();
      expect(cliErr.exitCode).toBe(EXIT.CONFIRMATION_REQUIRED);
      expect(cliErr.detail.code).toBe('confirmation_required');
      expect(cliErr.message).toContain("delete agent profile 'x'");
    }
  });
});

describe('ensureInteractive', () => {
  test('does nothing when the session is interactive', () => {
    expect(() =>
      ensureInteractive({
        action: 'run the create wizard',
        remediation: 'Use `pi-tin apply`.',
        isInteractive: true,
      }),
    ).not.toThrow();
  });

  test('throws interactive_only CliError when not interactive', () => {
    const err = (() => {
      try {
        ensureInteractive({
          action: 'run the create wizard',
          remediation: 'Use `pi-tin apply <name>` with workspace JSON on stdin.',
          isInteractive: false,
        });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.GENERAL);
    expect(err.detail.code).toBe('interactive_only');
    expect(err.detail.remediation).toBe('Use `pi-tin apply <name>` with workspace JSON on stdin.');
    expect(err.message).toBe('Cannot run the create wizard non-interactively — it needs a terminal.');
  });
});
