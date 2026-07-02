import { describe, test, expect } from 'bun:test';
import { confirmCleanup, prunePass } from './cleanup.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

describe('confirmCleanup', () => {
  // Regression: the global prunes used to run unconditionally when no stopped
  // pi-tin workspaces existed — the confirmation must gate the whole
  // destructive phase (README: exit 4 without a TTY unless --force).
  test('refuses non-interactively without force even with no stopped workspaces', async () => {
    try {
      await confirmCleanup({ stopped: [], force: false, isInteractive: false });
      throw new Error('expected confirmCleanup to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr: CliError = err instanceof CliError ? err : (() => { throw err; })();
      expect(cliErr.exitCode).toBe(EXIT.CONFIRMATION_REQUIRED);
      expect(cliErr.detail.code).toBe('confirmation_required');
    }
  });

  test('refuses non-interactively without force when stopped workspaces exist', async () => {
    try {
      await confirmCleanup({ stopped: ['ws-a'], force: false, isInteractive: false });
      throw new Error('expected confirmCleanup to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr: CliError = err instanceof CliError ? err : (() => { throw err; })();
      expect(cliErr.exitCode).toBe(EXIT.CONFIRMATION_REQUIRED);
    }
  });

  test('force proceeds without prompting, with or without stopped workspaces', async () => {
    expect(await confirmCleanup({ stopped: [], force: true, isInteractive: false })).toBe(true);
    expect(await confirmCleanup({ stopped: ['ws-a', 'ws-b'], force: true, isInteractive: false })).toBe(true);
  });
});

describe('prunePass', () => {
  test('reports removed when the command produces output', () => {
    const result = prunePass(['prune'], () => '  deleted abc123  ');
    expect(result).toEqual({ status: 'removed', output: 'deleted abc123' });
  });

  test('reports empty when the command succeeds with no output', () => {
    const result = prunePass(['prune'], () => '   ');
    expect(result).toEqual({ status: 'empty' });
  });

  test('reports failed (not empty) when the command throws', () => {
    const result = prunePass(['prune'], () => {
      throw new Error('container daemon not running');
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.message).toContain('daemon not running');
    }
  });

  test('prefers stderr text in the failure message when present', () => {
    const result = prunePass(['prune'], () => {
      const err = new Error('Command failed') as Error & { stderr: string };
      err.stderr = 'permission denied';
      throw err;
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.message).toContain('permission denied');
    }
  });
});
