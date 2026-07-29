import { execFileSync, spawn } from 'node:child_process';
import * as v from 'valibot';
import {
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  containerNameFor,
  getContainerState,
  stopContainer,
  deleteContainer,
} from './container.js';
import {
  withWorkspaceLock,
  reconcileWorkspaceRuntimeState,
  readShutdown,
  armShutdown,
  clearWorkspaceRuntimeState,
} from './runtime-state.js';
import { planAutoStopDecision, type HerdrAgentStates } from './workspace-plans.js';
import { HerdrAgentListSchema, type ContainerProfile, type Workspace } from './validators.js';
import { loadWorkspace } from './workspaces.js';
import { loadContainerProfile } from './profiles.js';
import { parseDurationMs } from './duration.js';
import { syncableWorkspaceStatePaths, syncWorkspaceState } from './workspace-state.js';
import { captureContainerDmesg } from './container-lifecycle.js';
import { removeWorkspaceSshArtifacts } from './ssh-endpoint.js';

// Hidden CLI sentinel used to re-invoke pi-tin as a detached auto-stop helper.
export const AUTO_STOP_COMMAND = '__auto-stop-if-idle';

const MAX_TIMER_MS = 2_147_483_647;

/**
 * A wait longer than the timer ceiling is served in chunks: `setTimeout`
 * silently fires immediately above this bound, so a long
 * `stopAfterLastSession` would otherwise stop the workspace at once.
 */
export function nextTimerChunkMs(remainingMs: number): number {
  return Math.min(remainingMs, MAX_TIMER_MS);
}

async function sleepUntil(deadlineMs: number): Promise<void> {
  while (true) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, nextTimerChunkMs(remainingMs));
    });
  }
}

export function spawnAutoStopHelper(workspaceName: string, deadlineMs: number): number | undefined {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return undefined;
  }

  try {
    const child = spawn(process.execPath, [
      scriptPath,
      AUTO_STOP_COMMAND,
      workspaceName,
      String(deadlineMs),
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });

    child.unref();
    return child.pid ?? undefined;
  } catch {
    return undefined;
  }
}

type HerdrAgentListExec = (containerName: string, user: string) => string;

const execHerdrAgentList: HerdrAgentListExec = (containerName, user) =>
  execFileSync('container', [
    'exec',
    '--user',
    user,
    containerName,
    '/bin/sh',
    '-c',
    'herdr agent list',
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CONTAINER_SUBPROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

// Any failure (herdr not yet installed, no server running, timeout, unparseable
// output) is 'unavailable' — the planner then stops, which is recoverable via
// herdr's restore-and-resume on the next open.
export function queryHerdrAgentStates(
  containerName: string,
  user: string,
  exec: HerdrAgentListExec = execHerdrAgentList,
): HerdrAgentStates {
  try {
    const agents = v.parse(HerdrAgentListSchema, JSON.parse(exec(containerName, user)));
    return {
      kind: 'states',
      working: agents.filter((agent) => agent.status === 'working').length,
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export type HerdrStopContext =
  | { herdrAttach: false }
  | {
    herdrAttach: true;
    containerProfile: ContainerProfile;
    /** workspace_state paths cleared to sync (managed-mount overlaps dropped). */
    statePaths: string[];
    stopAfterMs: number;
  };

// Config may be gone or invalid by the time the detached helper fires; that
// downgrades to the plain non-herdr stop path rather than failing the helper.
// The overlap filter runs here, silently — the helper is detached with no
// terminal; the interactive open already warned about any dropped path.
export function gatherHerdrStopContext(workspaceName: string): HerdrStopContext {
  try {
    const workspace: Workspace = loadWorkspace(workspaceName);
    if (workspace.attach !== 'herdr') {
      return { herdrAttach: false };
    }
    const containerProfile = loadContainerProfile(workspace.profile);
    return {
      herdrAttach: true,
      containerProfile,
      statePaths: syncableWorkspaceStatePaths(workspace, containerProfile).syncable,
      stopAfterMs: parseDurationMs(workspace.stopAfterLastSession),
    };
  } catch {
    return { herdrAttach: false };
  }
}

// Seams for the detached helper: every effect it performs is injectable so the
// branch logic can be tested without containers, timers, or runtime state.
export interface AutoStopDeps {
  sleepUntil: typeof sleepUntil;
  withWorkspaceLock: typeof withWorkspaceLock;
  readShutdown: typeof readShutdown;
  reconcileWorkspaceRuntimeState: typeof reconcileWorkspaceRuntimeState;
  gatherHerdrStopContext: typeof gatherHerdrStopContext;
  getContainerState: typeof getContainerState;
  queryHerdrAgentStates: typeof queryHerdrAgentStates;
  spawnAutoStopHelper: typeof spawnAutoStopHelper;
  armShutdown: typeof armShutdown;
  // Deliberately one-parameter: the helper never injects sync dependencies.
  syncWorkspaceState: (options: Parameters<typeof syncWorkspaceState>[0]) => Promise<void>;
  captureContainerDmesg: typeof captureContainerDmesg;
  stopContainer: typeof stopContainer;
  deleteContainer: typeof deleteContainer;
  clearWorkspaceRuntimeState: typeof clearWorkspaceRuntimeState;
  removeWorkspaceSshArtifacts: typeof removeWorkspaceSshArtifacts;
  now: () => number;
}

const defaultAutoStopDeps: AutoStopDeps = {
  sleepUntil,
  withWorkspaceLock,
  readShutdown,
  reconcileWorkspaceRuntimeState,
  gatherHerdrStopContext,
  getContainerState,
  queryHerdrAgentStates,
  spawnAutoStopHelper,
  armShutdown,
  syncWorkspaceState,
  captureContainerDmesg,
  stopContainer,
  deleteContainer,
  clearWorkspaceRuntimeState,
  removeWorkspaceSshArtifacts,
  now: () => Date.now(),
};

export async function runAutoStopHelper(
  workspaceName: string,
  deadlineMs: number,
  overrides: Partial<AutoStopDeps> = {},
): Promise<void> {
  const deps = { ...defaultAutoStopDeps, ...overrides };

  await deps.sleepUntil(deadlineMs);

  await deps.withWorkspaceLock(workspaceName, async () => {
    const shutdown = deps.readShutdown(workspaceName);
    const runtime = deps.reconcileWorkspaceRuntimeState(workspaceName);
    const containerName = containerNameFor(workspaceName);
    const state = deps.getContainerState(containerName);
    const herdrContext = deps.gatherHerdrStopContext(workspaceName);

    const agentStates: HerdrAgentStates = herdrContext.herdrAttach && state === 'running'
      ? deps.queryHerdrAgentStates(containerName, herdrContext.containerProfile.user)
      : { kind: 'not-applicable' };

    // 'unknown' container state also bails: when listing containers fails, do
    // nothing — never stop or clear state based on an unverified state.
    const plan = planAutoStopDecision({
      containerState: state,
      runtimeState: runtime.runtimeState,
      activeSessions: runtime.activeSessions.length,
      deadlineMatches: shutdown !== null && shutdown.deadlineMs === deadlineMs,
      agentStates,
    });

    if (plan.action === 'bail') {
      return;
    }

    if (plan.action === 'defer') {
      if (!herdrContext.herdrAttach) {
        return;
      }
      // One clock read: two would let armedAt and the deadline it is measured
      // against come from different instants.
      const armNow = deps.now();
      const nextDeadlineMs = armNow + herdrContext.stopAfterMs;
      const helperPid = deps.spawnAutoStopHelper(workspaceName, nextDeadlineMs);
      deps.armShutdown(workspaceName, {
        armedAt: new Date(armNow).toISOString(),
        deadlineMs: nextDeadlineMs,
        helperPid,
      });
      return;
    }

    // Only herdr workspaces sync here. Every other workspace already copied
    // its tool state out when its last session closed (finishWorkspaceSession),
    // and nothing ran in the container since. herdr agents keep working after
    // that point, so their tool state has moved on by the time this helper
    // fires. Best-effort like every sync. (herdr's own session/restore state
    // needs no snapshot at all — it is a live host mount.)
    if (herdrContext.herdrAttach) {
      await deps.syncWorkspaceState({
        containerName,
        workspaceName,
        paths: herdrContext.statePaths,
        user: herdrContext.containerProfile.user,
        direction: 'copy-out',
      });
    }

    // A 'stop' plan implies the container was running, so the guest kernel
    // log still exists to capture.
    deps.captureContainerDmesg(containerName);

    // Deliberately not stopAndRemoveContainer: this detached helper runs while holding
    // the workspace lock, so it must stay best-effort — never poll and never throw.
    try {
      deps.stopContainer(containerName);
    } catch {
      // Best effort only.
    }

    const postState = deps.getContainerState(containerName);
    if (postState === 'stopped') {
      try {
        deps.deleteContainer(containerName);
      } catch {
        // Best effort only.
      }
    }

    // Clear only on a confirmed non-running state — an 'unknown' post-state
    // must leave the runtime records for the next invocation to reconcile.
    if (postState === 'stopped' || postState === 'not-found') {
      deps.clearWorkspaceRuntimeState(workspaceName);
      deps.removeWorkspaceSshArtifacts(workspaceName, { clearKnownHosts: false });
    }
  });
}
