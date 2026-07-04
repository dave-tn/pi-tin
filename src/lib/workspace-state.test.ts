import { describe, test, expect } from 'bun:test';
import { planWorkspaceStateSync } from './workspace-state.js';

const hostStateDir = '/host/workspace-state/myws';

describe('planWorkspaceStateSync copy-in', () => {
  test('per entry: remove stale destination, copy in, then fix ownership', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(ops).toEqual([
      { kind: 'remove-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.zsh_history', containerPath: '/home/dev/.zsh_history' },
      { kind: 'chown-container-path', containerPath: '/home/dev/.zsh_history', user: 'dev' },
    ]);
  });

  test('derives nested container and host paths', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.local/share/zoxide'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(ops[1]).toEqual({
      kind: 'copy-in',
      hostPath: '/host/workspace-state/myws/.local/share/zoxide',
      containerPath: '/home/dev/.local/share/zoxide',
    });
  });

  test('uses /root as home for the root user', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'root',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(ops[0]).toEqual({ kind: 'remove-container-path', containerPath: '/root/.zsh_history' });
  });
});

describe('planWorkspaceStateSync copy-out', () => {
  test('per entry: ensure host parent, remove stale host copy, then copy out', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    });

    expect(ops).toEqual([
      { kind: 'ensure-host-parent', hostPath: '/host/workspace-state/myws/.zsh_history' },
      { kind: 'remove-host-path', hostPath: '/host/workspace-state/myws/.zsh_history' },
      { kind: 'copy-out', containerPath: '/home/dev/.zsh_history', hostPath: '/host/workspace-state/myws/.zsh_history' },
    ]);
  });
});

describe('planWorkspaceStateSync ordering and edges', () => {
  test('preserves entry order across the flattened op list', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history', '.local/share/zoxide'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    const containerPaths = ops.flatMap((op) =>
      op.kind === 'copy-in' ? [op.containerPath] : [],
    );
    expect(containerPaths).toEqual(['/home/dev/.zsh_history', '/home/dev/.local/share/zoxide']);
  });

  test('no entries produces no operations', () => {
    expect(planWorkspaceStateSync({ entries: [], user: 'dev', hostStateDir, direction: 'copy-in' })).toEqual([]);
    expect(planWorkspaceStateSync({ entries: [], user: 'dev', hostStateDir, direction: 'copy-out' })).toEqual([]);
  });
});
