import { describe, test, expect } from 'bun:test';
import {
  queryHerdrAgentStates,
  runAutoStopHelper,
  type AutoStopDeps,
  type HerdrStopContext,
} from './auto-stop.js';
import type { ContainerState } from './container.js';
import type { RuntimeStateStatus, SessionRecord, ShutdownRecord } from './runtime-state.js';
import { validateContainerProfile, validateWorkspace } from './validators.js';
import type { HerdrAgentStates } from './workspace-plans.js';

// Verified live output of `herdr agent list` (herdr 0.7.x).
const agentList = (statuses: string[]): string =>
  JSON.stringify({
    id: 'cli:agent:list',
    result: {
      agents: statuses.map((agent_status, index) => ({ agent: 'claude', agent_status, pane_id: `w1:p${index}` })),
      type: 'agent_list',
    },
  });

describe('queryHerdrAgentStates', () => {
  test('counts working agents from the real result.agents payload', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () =>
      agentList(['working', 'idle', 'working', 'done']),
    )).toEqual({ kind: 'states', working: 2 });
  });

  test('counts zero when agents are idle/blocked', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () =>
      agentList(['idle', 'blocked']),
    )).toEqual({ kind: 'states', working: 0 });
  });

  test('downgrades exec failure, non-JSON, and unexpected shapes to unavailable', () => {
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => {
      throw new Error('container exec timed out');
    })).toEqual({ kind: 'unavailable' });
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => 'herdr: no server running'))
      .toEqual({ kind: 'unavailable' });
    expect(queryHerdrAgentStates('pi-tin-demo', 'dev', () => JSON.stringify({ nope: true })))
      .toEqual({ kind: 'unavailable' });
  });
});

const NOW_MS = 1_800_000_000_000;
const NOW_ISO = '2027-01-15T08:00:00.000Z';
const DEADLINE_MS = 1_799_999_970_000;
const STOP_AFTER_MS = 300_000;

const activeSession: SessionRecord = {
  sessionId: 'session-1',
  startedAt: NOW_ISO,
  hostPid: 4321,
  state: 'active',
};

const armedShutdown: ShutdownRecord = {
  armedAt: NOW_ISO,
  deadlineMs: DEADLINE_MS,
  helperPid: 999,
};

const herdrStopContext: HerdrStopContext = {
  herdrAttach: true,
  containerProfile: validateContainerProfile({
    description: 'test profile',
    base_image: 'debian:trixie-slim',
    user: 'dev',
  }),
  workspace: validateWorkspace({
    profile: 'default',
    projects: [],
    attach: 'herdr',
    stopAfterLastSession: '5m',
  }),
  stopAfterMs: STOP_AFTER_MS,
};

type SyncOptions = Parameters<AutoStopDeps['syncWorkspaceState']>[0];

interface SshCleanupCall {
  workspaceName: string;
  options: { clearKnownHosts: boolean };
}

interface SpawnCall {
  workspaceName: string;
  deadlineMs: number;
}

interface Harness {
  deps: AutoStopDeps;
  calls: string[];
  armed: ShutdownRecord[];
  spawned: SpawnCall[];
  syncOptions: SyncOptions[];
  sleptUntil: number[];
  sshCleanups: SshCleanupCall[];
  stateReads: () => number;
}

// Any seam a test does not expect to reach is replaced with this, so a
// regression that starts using it fails loudly instead of silently passing.
const unexpected = (seam: string) => (): never => {
  throw new Error(`unexpected ${seam} seam`);
};

// Recording deps for the detached helper: no timers, no lock, no containers.
// `getContainerState` is scripted pre-stop → post-stop, matching the two reads
// the helper makes around the stop.
function createHarness(options: {
  containerState: ContainerState;
  postState?: ContainerState;
  runtimeState?: RuntimeStateStatus;
  activeSessions?: SessionRecord[];
  shutdown?: ShutdownRecord | null;
  herdr: HerdrStopContext;
  agentStates?: HerdrAgentStates;
  spawnPid?: number;
  onStop?: () => void;
}): Harness {
  const calls: string[] = [];
  const armed: ShutdownRecord[] = [];
  const spawned: SpawnCall[] = [];
  const syncOptions: SyncOptions[] = [];
  const sleptUntil: number[] = [];
  const sshCleanups: SshCleanupCall[] = [];
  const shutdown = options.shutdown === undefined ? armedShutdown : options.shutdown;
  let stateReads = 0;

  const deps: AutoStopDeps = {
    sleepUntil: async (deadlineMs: number) => {
      sleptUntil.push(deadlineMs);
    },
    withWorkspaceLock: async <T>(_workspaceName: string, fn: () => Promise<T> | T): Promise<T> =>
      await fn(),
    readShutdown: () => shutdown,
    reconcileWorkspaceRuntimeState: () => ({
      runtimeState: options.runtimeState ?? 'ok',
      activeSessions: options.activeSessions ?? [],
      shutdown,
      meta: null,
      warnings: [],
    }),
    gatherHerdrStopContext: () => options.herdr,
    getContainerState: () => {
      stateReads += 1;
      return stateReads === 1 ? options.containerState : options.postState ?? 'stopped';
    },
    queryHerdrAgentStates: () => options.agentStates ?? { kind: 'unavailable' },
    spawnAutoStopHelper: (workspaceName: string, deadlineMs: number) => {
      calls.push('spawn');
      spawned.push({ workspaceName, deadlineMs });
      return options.spawnPid;
    },
    armShutdown: (_workspaceName: string, record: ShutdownRecord) => {
      calls.push('arm');
      armed.push(record);
    },
    syncWorkspaceState: async (syncOpts: SyncOptions) => {
      calls.push('sync-copy-out');
      syncOptions.push(syncOpts);
    },
    stopContainer: () => {
      calls.push('stop');
      options.onStop?.();
    },
    deleteContainer: () => {
      calls.push('delete');
    },
    clearWorkspaceRuntimeState: () => {
      calls.push('clear');
    },
    removeWorkspaceSshArtifacts: (workspaceName: string, sshOptions: { clearKnownHosts: boolean }) => {
      calls.push('ssh-cleanup');
      sshCleanups.push({ workspaceName, options: sshOptions });
    },
    now: () => NOW_MS,
  };

  return {
    deps,
    calls,
    armed,
    spawned,
    syncOptions,
    sleptUntil,
    sshCleanups,
    stateReads: () => stateReads,
  };
}

describe('runAutoStopHelper', () => {
  test('waits for the deadline then does nothing while a session is still active', async () => {
    const harness = createHarness({
      containerState: 'running',
      activeSessions: [activeSession],
      herdr: { herdrAttach: false },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      stopContainer: unexpected('stopContainer'),
      deleteContainer: unexpected('deleteContainer'),
      clearWorkspaceRuntimeState: unexpected('clearWorkspaceRuntimeState'),
      removeWorkspaceSshArtifacts: unexpected('removeWorkspaceSshArtifacts'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.sleptUntil).toEqual([DEADLINE_MS]);
    expect(harness.calls).toEqual([]);
  });

  test('does nothing when the container state could not be determined', async () => {
    const harness = createHarness({
      containerState: 'unknown',
      herdr: { herdrAttach: false },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      stopContainer: unexpected('stopContainer'),
      deleteContainer: unexpected('deleteContainer'),
      clearWorkspaceRuntimeState: unexpected('clearWorkspaceRuntimeState'),
      removeWorkspaceSshArtifacts: unexpected('removeWorkspaceSshArtifacts'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.calls).toEqual([]);
  });

  test('re-arms with a fresh helper while herdr agents are still working', async () => {
    const harness = createHarness({
      containerState: 'running',
      herdr: herdrStopContext,
      agentStates: { kind: 'states', working: 1 },
      spawnPid: 4242,
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      stopContainer: unexpected('stopContainer'),
      deleteContainer: unexpected('deleteContainer'),
      clearWorkspaceRuntimeState: unexpected('clearWorkspaceRuntimeState'),
      removeWorkspaceSshArtifacts: unexpected('removeWorkspaceSshArtifacts'),
    });

    expect(harness.calls).toEqual(['spawn', 'arm']);
    expect(harness.spawned).toEqual([
      { workspaceName: 'demo', deadlineMs: NOW_MS + STOP_AFTER_MS },
    ]);
    expect(harness.armed).toEqual([
      { armedAt: NOW_ISO, deadlineMs: NOW_MS + STOP_AFTER_MS, helperPid: 4242 },
    ]);
  });

  test('re-arms without a helper pid when the respawn fails', async () => {
    const harness = createHarness({
      containerState: 'running',
      herdr: herdrStopContext,
      agentStates: { kind: 'states', working: 2 },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      stopContainer: unexpected('stopContainer'),
      deleteContainer: unexpected('deleteContainer'),
      clearWorkspaceRuntimeState: unexpected('clearWorkspaceRuntimeState'),
      removeWorkspaceSshArtifacts: unexpected('removeWorkspaceSshArtifacts'),
    });

    expect(harness.calls).toEqual(['spawn', 'arm']);
    expect(harness.armed).toHaveLength(1);
    const record = harness.armed[0];
    expect(record?.armedAt).toBe(NOW_ISO);
    expect(record?.deadlineMs).toBe(NOW_MS + STOP_AFTER_MS);
    expect(record?.helperPid).toBeUndefined();
  });

  test('snapshots herdr state out before stopping a herdr workspace', async () => {
    const harness = createHarness({
      containerState: 'running',
      postState: 'stopped',
      herdr: herdrStopContext,
      agentStates: { kind: 'states', working: 0 },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.calls).toEqual(['sync-copy-out', 'stop', 'delete', 'clear', 'ssh-cleanup']);
    expect(harness.syncOptions).toEqual([{
      containerName: 'pi-tin-demo',
      workspaceName: 'demo',
      entries: [
        { kind: 'tool-state', path: '.config/herdr' },
        { kind: 'binary', path: '.local/bin/herdr', executable: true },
      ],
      user: 'dev',
      direction: 'copy-out',
    }]);
  });

  test('stops a non-herdr workspace without any state copy-out', async () => {
    const harness = createHarness({
      containerState: 'running',
      postState: 'stopped',
      herdr: { herdrAttach: false },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.calls).toEqual(['stop', 'delete', 'clear', 'ssh-cleanup']);
  });

  test('leaves runtime records alone when the post-stop state is unknown', async () => {
    const harness = createHarness({
      containerState: 'running',
      postState: 'unknown',
      herdr: { herdrAttach: false },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
      deleteContainer: unexpected('deleteContainer'),
      clearWorkspaceRuntimeState: unexpected('clearWorkspaceRuntimeState'),
      removeWorkspaceSshArtifacts: unexpected('removeWorkspaceSshArtifacts'),
    });

    expect(harness.calls).toEqual(['stop']);
  });

  test.each([
    ['stopped', ['stop', 'delete', 'clear', 'ssh-cleanup']],
    ['not-found', ['stop', 'clear', 'ssh-cleanup']],
  ] as const)('clears runtime state on a confirmed %s post-stop state', async (postState, expected) => {
    const harness = createHarness({
      containerState: 'running',
      postState,
      herdr: { herdrAttach: false },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.calls).toEqual([...expected]);
    expect(harness.sshCleanups).toEqual([
      { workspaceName: 'demo', options: { clearKnownHosts: false } },
    ]);
  });

  test('rechecks the state and still removes the container when the stop call throws', async () => {
    const harness = createHarness({
      containerState: 'running',
      postState: 'stopped',
      herdr: { herdrAttach: false },
      onStop: () => {
        throw new Error('container stop timed out');
      },
    });

    await runAutoStopHelper('demo', DEADLINE_MS, {
      ...harness.deps,
      queryHerdrAgentStates: unexpected('queryHerdrAgentStates'),
      syncWorkspaceState: unexpected('syncWorkspaceState'),
      spawnAutoStopHelper: unexpected('spawnAutoStopHelper'),
      armShutdown: unexpected('armShutdown'),
    });

    expect(harness.stateReads()).toBe(2);
    expect(harness.calls).toEqual(['stop', 'delete', 'clear', 'ssh-cleanup']);
  });
});
