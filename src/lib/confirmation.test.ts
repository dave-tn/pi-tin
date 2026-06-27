import { describe, expect, test } from 'bun:test';
import { planConfirmation, confirmDestructive } from './confirmation.js';
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
