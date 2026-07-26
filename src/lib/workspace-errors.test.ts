import { describe, expect, test } from 'bun:test';
import { EXIT } from './cli-errors.js';
import { notFoundWorkspaceError } from './workspace-errors.js';

describe('notFoundWorkspaceError', () => {
  test('exit code is NOT_FOUND and message enumerates available workspaces', () => {
    const err = notFoundWorkspaceError('ghost', ['work', 'scratch']);
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.detail.badInput).toBe('ghost');
    expect(err.detail.validValues).toEqual(['work', 'scratch']);
    expect(err.detail.remediation).toBe('Run `pi-tin list` to see available workspaces.');
    expect(err.message).toBe("Workspace 'ghost' not found. Available: work, scratch");
  });

  test('handles the no-workspaces-configured case', () => {
    const err = notFoundWorkspaceError('ghost', []);
    expect(err.detail.validValues).toEqual([]);
    expect(err.detail.remediation).toBe('Run `pi-tin list` to see available workspaces.');
    expect(err.message).toBe("Workspace 'ghost' not found — no workspaces configured.");
  });
});
