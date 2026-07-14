import { describe, test, expect } from 'bun:test';
import { confirmCleanup, fullWipe, prunePass } from './cleanup.js';
import { planCleanup, selectOrphanedImages } from '../lib/workspace-plans.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

describe('planCleanup', () => {
  test('refuses when containers could not be listed', () => {
    expect(planCleanup(null)).toEqual({
      action: 'refuse',
      message:
        'Could not list containers, so cleanup cannot tell which workspaces are running.\n'
        + "Check the container system is running ('container system start'), then retry.",
    });
  });

  test('partitions pi-tin containers into running and stopped workspaces', () => {
    expect(planCleanup([
      { id: 'pi-tin-alpha', status: 'running' },
      { id: 'pi-tin-beta', status: 'stopped' },
      { id: 'pi-tin-gamma', status: 'created' },
    ])).toEqual({
      action: 'clean',
      runningWorkspaces: ['alpha'],
      stoppedWorkspaces: ['beta', 'gamma'],
    });
  });

  test('ignores containers that are not pi-tin workspaces', () => {
    expect(planCleanup([
      { id: 'unrelated', status: 'running' },
      { id: 'other', status: 'stopped' },
    ])).toEqual({
      action: 'clean',
      runningWorkspaces: [],
      stoppedWorkspaces: [],
    });
  });

  test('returns an empty clean plan for an empty host', () => {
    expect(planCleanup([])).toEqual({
      action: 'clean',
      runningWorkspaces: [],
      stoppedWorkspaces: [],
    });
  });
});

describe('selectOrphanedImages', () => {
  test('selects pi-tin images with no matching workspace', () => {
    expect(selectOrphanedImages({
      imageNames: ['pi-tin-alpha', 'pi-tin-gone', 'ubuntu:latest'],
      workspaceNames: ['alpha'],
    })).toEqual(['pi-tin-gone']);
  });

  test('never selects non-pi-tin images, even without workspaces', () => {
    expect(selectOrphanedImages({
      imageNames: ['ubuntu:latest', 'node:22'],
      workspaceNames: [],
    })).toEqual([]);
  });

  test('selects nothing when every pi-tin image has a workspace', () => {
    expect(selectOrphanedImages({
      imageNames: ['pi-tin-alpha', 'pi-tin-beta'],
      workspaceNames: ['alpha', 'beta'],
    })).toEqual([]);
  });
});

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

describe('fullWipe', () => {
  test('refuses with a structured error while workspaces are running', async () => {
    const err = await fullWipe(['ctwo', 'blitz'], true, false).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.GENERAL);
    expect(err.detail.code).toBe('workspaces_running');
    expect(err.detail.remediation).toContain('pi-tin stop ctwo');
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
