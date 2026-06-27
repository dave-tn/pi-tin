import { describe, test, expect } from 'bun:test';
import { prunePass } from './cleanup.js';

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
