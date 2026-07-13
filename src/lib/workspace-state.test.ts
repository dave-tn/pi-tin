import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planWorkspaceStateSync, syncWorkspaceState } from './workspace-state.js';

const hostStateDir = '/host/workspace-state/myws';

describe('planWorkspaceStateSync copy-in', () => {
  test('per entry: remove stale destination, copy in, then fix ownership', () => {
    const groups = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups).toEqual([[
      { kind: 'remove-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-in', hostPath: '/host/workspace-state/myws/.zsh_history', containerPath: '/home/dev/.zsh_history' },
      { kind: 'chown-container-path', containerPath: '/home/dev/.zsh_history', user: 'dev' },
    ]]);
  });

  test('derives nested container and host paths', () => {
    const groups = planWorkspaceStateSync({
      entries: ['.local/share/zoxide'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups[0]?.[1]).toEqual({
      kind: 'copy-in',
      hostPath: '/host/workspace-state/myws/.local/share/zoxide',
      containerPath: '/home/dev/.local/share/zoxide',
    });
  });

  test('uses /root as home for the root user', () => {
    const groups = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'root',
      hostStateDir,
      direction: 'copy-in',
    });

    expect(groups[0]?.[0]).toEqual({ kind: 'remove-container-path', containerPath: '/root/.zsh_history' });
  });
});

describe('planWorkspaceStateSync copy-out', () => {
  test('per entry: copy into a temp sibling, then swap it into place', () => {
    const groups = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    });

    expect(groups).toEqual([[
      { kind: 'ensure-host-parent', hostPath: '/host/workspace-state/myws/.zsh_history' },
      { kind: 'remove-host-path', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp' },
      { kind: 'probe-container-path', containerPath: '/home/dev/.zsh_history' },
      { kind: 'copy-out', containerPath: '/home/dev/.zsh_history', hostPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp' },
      { kind: 'promote-temp', tempPath: '/host/workspace-state/myws/.zsh_history.pi-tin-tmp', hostPath: '/host/workspace-state/myws/.zsh_history' },
    ]]);
  });

  test('copies out before removing the previous snapshot, so a failed copy cannot destroy it', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-out',
    }).flat();

    const copyOutIndex = ops.findIndex((op) => op.kind === 'copy-out');
    const promoteIndex = ops.findIndex((op) => op.kind === 'promote-temp');
    // The only op that touches the real snapshot path is promote-temp, and it
    // runs after the copy — nothing deletes the live snapshot up front.
    expect(copyOutIndex).toBeLessThan(promoteIndex);
    expect(ops.some((op) => op.kind === 'remove-host-path' && op.hostPath === '/host/workspace-state/myws/.zsh_history')).toBe(false);
  });
});

describe('planWorkspaceStateSync ordering and edges', () => {
  test('preserves entry order across the op groups', () => {
    const ops = planWorkspaceStateSync({
      entries: ['.zsh_history', '.local/share/zoxide'],
      user: 'dev',
      hostStateDir,
      direction: 'copy-in',
    }).flat();

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

describe('syncWorkspaceState timeout handling', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('skips a missing container path and continues with later entries', () => {
    const calls: string[][] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.local/share/zoxide', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          const missingProbe = args[0] === 'exec' && args.at(-1) === '/home/dev/.local/share/zoxide';
          if (missingProbe) {
            throw new Error('missing');
          }
        },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.local/share/zoxide'],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
      ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.zsh_history.pi-tin-tmp')],
    ]);
  });

  test('warns and aborts the rest of the sync when the existence probe times out', () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          const error = new Error('spawnSync container ETIMEDOUT');
          Object.assign(error, { code: 'ETIMEDOUT' });
          throw error;
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-out: a timed-out copy skips only that path — later entries still sync', () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.nuget/packages', '.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          const oversizedCopy = args[0] === 'cp' && args[1] === 'pi-tin-demo:/home/dev/.nuget/packages';
          if (oversizedCopy) {
            const error = new Error('spawnSync container ETIMEDOUT');
            Object.assign(error, { code: 'ETIMEDOUT' });
            throw error;
          }
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.nuget/packages'],
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
      ['cp', 'pi-tin-demo:/home/dev/.zsh_history', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.zsh_history.pi-tin-tmp')],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.nuget/packages' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('copy-out: a wedged runtime stops the sync at the next probe after a timed-out copy', () => {
    const calls: string[][] = [];
    const warnings: string[] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.nuget/packages', '.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          // First probe answers before the runtime wedges; everything after
          // (the big copy, then the next entry's probe) hits the deadline.
          if (calls.length === 1) return;
          const error = new Error('spawnSync container ETIMEDOUT');
          Object.assign(error, { code: 'ETIMEDOUT' });
          throw error;
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.nuget/packages'],
      ['cp', 'pi-tin-demo:/home/dev/.nuget/packages', path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo', '.nuget/packages.pi-tin-tmp')],
      ['exec', '--user', 'root', 'pi-tin-demo', 'test', '-e', '/home/dev/.zsh_history'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.nuget/packages' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
      "Warning: workspace_state copy-out timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-in: still chowns the entry when its copy times out, then continues with later entries', () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');

    const calls: string[][] = [];
    const warnings: string[] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          if (args[0] === 'cp') {
            const error = new Error('spawnSync container ETIMEDOUT');
            Object.assign(error, { code: 'ETIMEDOUT' });
            throw error;
          }
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // The timed-out copy may have landed root-owned files, so the chown still
    // runs; the second entry still syncs (it has no host snapshot, so only its
    // remove and chown run).
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
      ['cp', path.join(stateDir, '.zsh_history'), 'pi-tin-demo:/home/dev/.zsh_history'],
      ['exec', '--user', 'root', 'pi-tin-demo', 'chown', '-R', 'dev:dev', '/home/dev/.zsh_history'],
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.local/share/zoxide'],
      ['exec', '--user', 'root', 'pi-tin-demo', 'chown', '-R', 'dev:dev', '/home/dev/.local/share/zoxide'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — skipping this path. It is likely too large to snapshot; workspace_state suits small tool state — persist large paths with a host.mounts entry instead (README → Workspace state).",
    ]);
  });

  test('copy-in: a timed-out remove skips the rest of the entry and the sync', () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.zsh_history'), 'snapshot');

    const calls: string[][] = [];
    const warnings: string[] = [];

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.zsh_history', '.local/share/zoxide'],
        user: 'dev',
        direction: 'copy-in',
      },
      {
        run: (_file, args): void => {
          calls.push(args);
          if (args.includes('rm')) {
            const error = new Error('spawnSync container ETIMEDOUT');
            Object.assign(error, { code: 'ETIMEDOUT' });
            throw error;
          }
        },
        warn: (message): void => {
          warnings.push(message);
        },
      },
    );

    // A timed-out `rm` (near-instant when the runtime is healthy) means the
    // runtime is wedged: neither the copy nor the chown is attempted and the
    // rest of the sync is abandoned.
    expect(calls).toEqual([
      ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
    ]);
    expect(warnings).toEqual([
      "Warning: workspace_state copy-in timed out after 5s for '/home/dev/.zsh_history' in workspace 'demo' — container runtime unresponsive; skipping the rest of this sync.",
    ]);
  });

  test('copy-out: a partial temp left by a timed-out copy is never promoted over the previous snapshot', () => {
    const stateDir = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPath = path.join(stateDir, '.zsh_history');
    fs.writeFileSync(snapshotPath, 'previous snapshot');

    syncWorkspaceState(
      {
        containerName: 'pi-tin-demo',
        workspaceName: 'demo',
        entries: ['.zsh_history'],
        user: 'dev',
        direction: 'copy-out',
      },
      {
        run: (_file, args): void => {
          if (args[0] !== 'cp') return;
          // Simulate a copy SIGKILLed mid-write: a partial temp exists.
          fs.writeFileSync(`${snapshotPath}.pi-tin-tmp`, 'partial');
          const error = new Error('spawnSync container ETIMEDOUT');
          Object.assign(error, { code: 'ETIMEDOUT' });
          throw error;
        },
        warn: (): void => {},
      },
    );

    expect(fs.readFileSync(snapshotPath, 'utf-8')).toBe('previous snapshot');
  });
});
