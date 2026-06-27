import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeStateApi } from './runtime-state.js';

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

  function createApi() {
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

  test('reports corrupt runtime files', () => {
    const api = createApi();
    const workspaceDir = runtimeDir(tmpDir, 'demo');
    fs.mkdirSync(path.join(workspaceDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'meta.json'), '{not json');
    fs.writeFileSync(path.join(workspaceDir, 'sessions', 'bad.json'), '{also bad');

    const runtime = api.reconcileWorkspaceRuntimeState('demo');
    expect(runtime.runtimeState).toBe('corrupt');
    expect(runtime.warnings.length).toBeGreaterThan(0);
  });
});
