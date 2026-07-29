import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeStateApi, type RuntimeStateApi, type RuntimeStateDeps } from './runtime-state.js';

function runtimeDir(baseDir: string, workspaceName: string): string {
  return path.join(baseDir, 'runtime', workspaceName);
}

describe('runtime-state', () => {
  let tmpDir: string;
  // Maps a live pid to its process-identity token. Presence ⇒ the pid is alive;
  // a changed token for the same pid models OS PID reuse by a different process.
  let procs: Map<number, string>;
  let killedPids: number[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-runtime-state-'));
    procs = new Map<number, string>([[999, 'token-999']]);
    killedPids = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApi(overrides: Partial<RuntimeStateDeps> = {}): RuntimeStateApi {
    return createRuntimeStateApi({
      getStateDir: () => tmpDir,
      now: () => 1_700_000_000_000,
      currentPid: () => 999,
      sleep: async () => {},
      isPidAlive: (pid: number) => procs.has(pid),
      getProcessToken: (pid: number) => procs.get(pid) ?? null,
      killProcess: (pid: number) => {
        killedPids.push(pid);
        procs.delete(pid);
      },
      ...overrides,
    });
  }

  test('registers and unregisters sessions', () => {
    const api = createApi();

    api.registerSession('demo', {
      sessionId: 'session-1',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });

    let runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.runtimeState).toBe('corrupt');
    expect(runtime.activeSessions).toHaveLength(1);

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });

    runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.runtimeState).toBe('ok');
    expect(runtime.activeSessions).toHaveLength(1);

    api.unregisterSession('demo', 'session-1');
    expect(api.reconcileWorkspaceRuntimeState('demo').activeSessions).toHaveLength(0);
  });

  // The mount record is what the workspace-state overlap filter reads back
  // for a container whose config has since moved on, so it has to survive the
  // round-trip through the meta schema rather than being stripped as unknown.
  test('carries the container mount record through a meta round-trip', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
      mountedContainerPaths: ['/workspace/proj', '/home/dev/.config/herdr'],
    });

    expect(api.readRuntimeMeta('demo')?.mountedContainerPaths)
      .toEqual(['/workspace/proj', '/home/dev/.config/herdr']);
  });

  test('reaps stale sessions during reconciliation', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'stale-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 123,
      state: 'active',
    });

    const runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.runtimeState).toBe('ok');
    expect(runtime.activeSessions).toHaveLength(0);
    expect(fs.existsSync(path.join(runtimeDir(tmpDir, 'demo'), 'sessions', 'stale-session.json'))).toBe(false);
  });

  test('reaps stale locks before acquiring a new lock', async () => {
    const api = createApi();
    const lockPath = path.join(runtimeDir(tmpDir, 'demo'), 'lock.json');

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ ownerPid: 123, acquiredAt: '2026-05-25T12:00:00.000Z' }));

    let called = false;
    await api.withWorkspaceLock('demo', () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // The blocking variant must wait out a live holder rather than reaping its
  // lock or running the body unprotected — the retry loop is the only thing
  // serialising two concurrent `pi-tin open`s on one workspace.
  test('withWorkspaceLock retries while a live holder owns the lock', async () => {
    const lockPath = path.join(runtimeDir(tmpDir, 'demo'), 'lock.json');
    procs.set(1234, 'token-1234');

    let sleeps = 0;
    const api = createApi({
      sleep: async () => {
        sleeps += 1;
        // The holder exits between retries; the next attempt reaps and wins.
        procs.delete(1234);
      },
    });

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: 1234, ownerToken: 'token-1234', acquiredAt: '2026-05-25T12:00:00.000Z' }),
    );

    let heldLock: string | undefined;
    const result = await api.withWorkspaceLock('demo', () => {
      heldLock = fs.readFileSync(lockPath, 'utf-8');
      return 'body-ran';
    });

    expect(sleeps).toBe(1);
    expect(result).toBe('body-ran');
    // The body runs under a lock this process owns, not the stale one.
    expect(JSON.parse(heldLock ?? '{}')).toMatchObject({ ownerPid: 999, ownerToken: 'token-999' });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('withWorkspaceLock releases the lock when the body throws', async () => {
    const api = createApi();
    const lockPath = path.join(runtimeDir(tmpDir, 'demo'), 'lock.json');

    await expect(api.withWorkspaceLock('demo', () => {
      throw new Error('body failed');
    })).rejects.toThrow('body failed');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('arms and cancels shutdowns, killing prior helper pids', () => {
    const api = createApi();

    api.armShutdown('demo', {
      armedAt: '2026-05-25T12:00:00.000Z',
      deadlineMs: 1000,
      helperPid: 111,
    });

    expect(api.readShutdown('demo')).toEqual({
      armedAt: '2026-05-25T12:00:00.000Z',
      deadlineMs: 1000,
      helperPid: 111,
    });

    api.armShutdown('demo', {
      armedAt: '2026-05-25T12:01:00.000Z',
      deadlineMs: 2000,
      helperPid: 222,
    });

    expect(killedPids).toEqual([111]);
    expect(api.readShutdown('demo')).toEqual({
      armedAt: '2026-05-25T12:01:00.000Z',
      deadlineMs: 2000,
      helperPid: 222,
    });

    api.cancelShutdown('demo');
    expect(killedPids).toEqual([111, 222]);
    expect(api.readShutdown('demo')).toBeNull();
  });

  test('does not kill the current process when clearing runtime state', () => {
    const api = createApi();

    api.armShutdown('demo', {
      armedAt: '2026-05-25T12:00:00.000Z',
      deadlineMs: 1000,
      helperPid: 999,
    });

    api.clearWorkspaceRuntimeState('demo');
    expect(killedPids).toEqual([]);
  });

  test('removes the workspace runtime directory when cleared without a lock', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'session-1',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });

    api.clearWorkspaceRuntimeState('demo');

    expect(fs.existsSync(runtimeDir(tmpDir, 'demo'))).toBe(false);
  });

  test('leaves only the lock file while clearing runtime state under a lock', async () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'session-1',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });

    await api.withWorkspaceLock('demo', () => {
      api.clearWorkspaceRuntimeState('demo');
      expect(fs.readdirSync(runtimeDir(tmpDir, 'demo'))).toEqual(['lock.json']);
    });

    expect(fs.existsSync(runtimeDir(tmpDir, 'demo'))).toBe(false);
  });

  test('reaps a lock whose owner PID was reused by a different process', async () => {
    const api = createApi();
    const lockPath = path.join(runtimeDir(tmpDir, 'demo'), 'lock.json');

    // Owner pid 999 is alive, but the recorded identity token is stale: the
    // process that took the lock died and the OS handed 999 to something else.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: 999, ownerToken: 'old-token', acquiredAt: '2026-05-25T12:00:00.000Z' }),
    );

    const result = await api.tryWithWorkspaceLock('demo', () => 'acquired');
    expect(result).toBe('acquired');
  });

  test('does not reap a lock whose owner identity still matches', async () => {
    const api = createApi();
    const lockPath = path.join(runtimeDir(tmpDir, 'demo'), 'lock.json');

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: 999, ownerToken: 'token-999', acquiredAt: '2026-05-25T12:00:00.000Z' }),
    );

    const result = await api.tryWithWorkspaceLock('demo', () => 'acquired');
    expect(result).toBeNull();
  });

  // The agent-install lock reuses the workspace lock's PID-token core but
  // lives in the workspace-state tree, so `pi-tin delete` reclaims it and it
  // cannot survive clearWorkspaceRuntimeState to block a later install.
  test('the agent install lock is per workspace and agent, inside the workspace-state dir', async () => {
    const stateDirs: string[] = [];
    const api = createApi({
      getWorkspaceStateDir: (workspaceName: string) => {
        stateDirs.push(workspaceName);
        return path.join(tmpDir, 'workspace-state', workspaceName);
      },
    });

    let lockPathDuringInstall = '';
    const result = await api.tryWithAgentInstallLock('demo', 'claude', () => {
      lockPathDuringInstall = path.join(tmpDir, 'workspace-state', 'demo', '.pi-tin-install-claude.lock');
      expect(fs.existsSync(lockPathDuringInstall)).toBe(true);
      return 'installed';
    });

    expect(result).toBe('installed');
    expect(stateDirs).toEqual(['demo']);
    // Released in a finally, so a later open is never blocked by this one.
    expect(fs.existsSync(lockPathDuringInstall)).toBe(false);
    // Never in the runtime dir: clearWorkspaceRuntimeState removes only
    // meta.json and sessions/, so a lock left there would defeat the
    // empty-dir pruning the workspace lock relies on.
    expect(fs.existsSync(runtimeDir(tmpDir, 'demo'))).toBe(false);
  });

  test('a second install of the same agent is refused while the first holds the lock', async () => {
    const api = createApi({
      getWorkspaceStateDir: (workspaceName: string) =>
        path.join(tmpDir, 'workspace-state', workspaceName),
    });

    const result = await api.tryWithAgentInstallLock('demo', 'claude', async () => {
      // A different agent in the same workspace has its own lock and proceeds.
      const other = await api.tryWithAgentInstallLock('demo', 'opencode', () => 'other-ok');
      // The same agent is refused: null, never a throw — the caller reports
      // "another open is installing", not a failure.
      const same = await api.tryWithAgentInstallLock('demo', 'claude', () => 'same-ok');
      return { other, same };
    });

    expect(result).toEqual({ other: 'other-ok', same: null });
  });

  test('an install lock left by a dead process is reclaimed', async () => {
    const api = createApi({
      getWorkspaceStateDir: (workspaceName: string) =>
        path.join(tmpDir, 'workspace-state', workspaceName),
    });
    const lockPath = path.join(tmpDir, 'workspace-state', 'demo', '.pi-tin-install-claude.lock');

    // A SIGKILLed pi-tin never ran its finally, so the lock file survives.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ownerPid: 4242, ownerToken: 'dead-token', acquiredAt: '2026-05-25T12:00:00.000Z' }),
    );

    expect(await api.tryWithAgentInstallLock('demo', 'claude', () => 'acquired')).toBe('acquired');
  });

  test('does not kill a helper whose PID was reused by a different process', () => {
    const api = createApi();
    procs.set(555, 'helper-orig');

    api.armShutdown('demo', {
      armedAt: '2026-05-25T12:00:00.000Z',
      deadlineMs: 1000,
      helperPid: 555,
    });

    // The helper exits and pid 555 is reused by an unrelated process.
    procs.set(555, 'reused-555');

    api.cancelShutdown('demo');
    expect(killedPids).not.toContain(555);
    expect(procs.has(555)).toBe(true);
  });

  test('kills a helper whose identity still matches', () => {
    const api = createApi();
    procs.set(556, 'helper-orig');

    api.armShutdown('demo', {
      armedAt: '2026-05-25T12:00:00.000Z',
      deadlineMs: 1000,
      helperPid: 556,
    });

    api.cancelShutdown('demo');
    expect(killedPids).toContain(556);
  });

  test('reaps a session whose host PID was reused by a different process', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'session-1',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });

    // The session's host process dies and pid 999 is reused.
    procs.set(999, 'reused-999');

    const runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.activeSessions).toHaveLength(0);
  });

  test('readRuntimeDecisionState short-circuits without reaping when the container is not running', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'stale-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 123,
      state: 'active',
    });

    const decision = api.readRuntimeDecisionState('demo', 'stopped');

    expect(decision).toEqual({ runtimeState: 'missing', activeSessions: 0 });
    // The stale session record must survive: the short-circuit may not reap.
    expect(fs.existsSync(path.join(runtimeDir(tmpDir, 'demo'), 'sessions', 'stale-session.json'))).toBe(true);
  });

  test('readRuntimeDecisionState reconciles when the container is running', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'live-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });
    api.registerSession('demo', {
      sessionId: 'stale-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 123,
      state: 'active',
    });

    const decision = api.readRuntimeDecisionState('demo', 'running');

    expect(decision).toEqual({ runtimeState: 'ok', activeSessions: 1 });
    expect(fs.existsSync(path.join(runtimeDir(tmpDir, 'demo'), 'sessions', 'stale-session.json'))).toBe(false);
  });

  // reconcile* reaps; the plain readers must not. Reaping from a read path
  // would delete another process's session record on any status query.
  test('readRuntimeSnapshot reports stale sessions without reaping them', () => {
    const api = createApi();

    api.writeRuntimeMeta('demo', {
      startedAt: '2026-05-25T12:00:00.000Z',
      buildHash: 'build-hash',
      runtimeHash: 'runtime-hash',
    });
    api.registerSession('demo', {
      sessionId: 'stale-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 123,
      state: 'active',
    });

    const runtime = api.readRuntimeSnapshot('demo');

    expect(runtime.runtimeState).toBe('ok');
    expect(runtime.activeSessions.map((session) => session.sessionId)).toEqual(['stale-session']);
    expect(fs.existsSync(path.join(runtimeDir(tmpDir, 'demo'), 'sessions', 'stale-session.json'))).toBe(true);
  });

  test('listSessionRecords returns every record on disk without reaping', () => {
    const api = createApi();

    api.registerSession('demo', {
      sessionId: 'live-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 999,
      state: 'active',
    });
    api.registerSession('demo', {
      sessionId: 'stale-session',
      startedAt: '2026-05-25T12:00:00.000Z',
      hostPid: 123,
      state: 'active',
    });

    expect(api.listSessionRecords('demo').map((session) => session.sessionId))
      .toEqual(['live-session', 'stale-session']);
    expect(fs.existsSync(path.join(runtimeDir(tmpDir, 'demo'), 'sessions', 'stale-session.json'))).toBe(true);

    // ...and reconciliation, which does reap, then drops the stale one.
    api.reconcileWorkspaceRuntimeState('demo');
    expect(api.listSessionRecords('demo').map((session) => session.sessionId)).toEqual(['live-session']);
  });

  test('listSessionRecords is empty for a workspace with no runtime state', () => {
    expect(createApi().listSessionRecords('never-opened')).toEqual([]);
  });

  test('reports corrupt runtime files', () => {
    const api = createApi();
    const workspaceDir = runtimeDir(tmpDir, 'demo');
    fs.mkdirSync(path.join(workspaceDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'meta.json'), '{not json');
    fs.writeFileSync(path.join(workspaceDir, 'sessions', 'bad.json'), '{also bad');

    const runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.runtimeState).toBe('corrupt');
    // Warnings are surfaced to the user, so each must name the workspace and
    // say which file is unreadable — one generic "corrupt state" is useless.
    expect(runtime.warnings).toEqual([
      "Runtime metadata is invalid for workspace 'demo'.",
      "One or more session records are invalid for workspace 'demo'.",
    ]);
  });
});
