import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CONTAINER_SUBPROCESS_TIMEOUT_MS,
  containerSystemRecoveryHint,
  execContainerCommandOutput,
  getContainerState,
  stopContainer,
  killContainer,
  deleteContainer,
  isContainerSubprocessTimeout,
  workspaceNameFromContainerId,
  type ContainerState,
} from './container.js';
import { getDiagnosticsDir } from './paths.js';
import { formatDurationMs } from './duration.js';

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
const KILL_WAIT_TIMEOUT_MS = 2000;

function couldNotDetermineStateMessage(containerName: string): string {
  return `Could not determine the state of container '${containerName}'.`;
}

// Guest kernel messages die with the container — each one is its own VM — so
// a crash inside (an OOM kill, a wedged runtime) leaves no post-mortem
// evidence once teardown deletes it. Snapshot dmesg to the host right before
// every stop of a running container: one file per workspace (~18 KB, latest
// life only), best-effort, never blocks teardown.
export function captureContainerDmesg(containerName: string): void {
  try {
    const dmesg = execContainerCommandOutput({
      name: containerName,
      user: 'root',
      command: ['dmesg'],
    });
    const diagnosticsDir = getDiagnosticsDir();
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    fs.writeFileSync(
      path.join(diagnosticsDir, `${workspaceNameFromContainerId(containerName)}.dmesg.log`),
      `# ${containerName} guest dmesg, captured pre-stop ${new Date().toISOString()}\n${dmesg}`,
    );
  } catch {
    // Diagnostics only — teardown must never depend on them.
  }
}

export interface ContainerLifecycleDeps {
  getContainerState: (name: string) => ContainerState;
  captureContainerDmesg: (name: string) => void;
  stopContainer: (name: string) => void;
  killContainer: (name: string) => void;
  deleteContainer: (name: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ContainerLifecycleApi {
  stopAndRemoveContainer: (
    containerName: string,
    options?: { force?: boolean; timeoutMs?: number },
  ) => Promise<void>;
}

const defaultDeps: ContainerLifecycleDeps = {
  getContainerState,
  captureContainerDmesg,
  stopContainer,
  killContainer,
  deleteContainer,
  now: () => Date.now(),
  sleep: async (ms: number) => {
    await sleep(ms);
  },
};

export function createContainerLifecycle(
  overrides: Partial<ContainerLifecycleDeps> = {},
): ContainerLifecycleApi {
  const deps: ContainerLifecycleDeps = {
    ...defaultDeps,
    ...overrides,
  };

  const waitForContainerToStop = async (
    containerName: string,
    timeoutMs: number,
  ): Promise<ContainerState> => {
    const deadline = deps.now() + timeoutMs;

    while (deps.now() < deadline) {
      const state = deps.getContainerState(containerName);
      if (state !== 'running') {
        return state;
      }
      await deps.sleep(POLL_INTERVAL_MS);
    }

    return deps.getContainerState(containerName);
  };

  /**
   * Stop a workspace container and remove it once stopped. Silent by design —
   * callers own all user-facing output. With `force`, escalates to a kill when
   * a graceful stop does not finish within the timeout. Throws only when the
   * container is still running after all attempts.
   */
  const stopAndRemoveContainer = async (
    containerName: string,
    options: { force?: boolean; timeoutMs?: number } = {},
  ): Promise<void> => {
    const { force = false, timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = options;

    const initialState = deps.getContainerState(containerName);
    if (initialState === 'not-found') {
      return;
    }

    if (initialState === 'unknown') {
      throw new Error(couldNotDetermineStateMessage(containerName));
    }

    let timedOutAction: 'stop' | 'kill' | null = null;

    if (initialState === 'running') {
      deps.captureContainerDmesg(containerName);
      try {
        deps.stopContainer(containerName);
      } catch (error) {
        if (isContainerSubprocessTimeout(error)) {
          timedOutAction = 'stop';
        }
        // Check state below and optionally escalate.
      }
    }

    let state = await waitForContainerToStop(containerName, timeoutMs);
    if (state === 'running' && force) {
      try {
        deps.killContainer(containerName);
      } catch (error) {
        if (isContainerSubprocessTimeout(error)) {
          timedOutAction = 'kill';
        }
        // Check final state below.
      }
      state = await waitForContainerToStop(containerName, KILL_WAIT_TIMEOUT_MS);
    }

    if (state === 'running') {
      if (timedOutAction !== null) {
        throw new Error(
          `Apple 'container ${timedOutAction}' did not respond within ${formatDurationMs(CONTAINER_SUBPROCESS_TIMEOUT_MS)} for container '${containerName}'. ${containerSystemRecoveryHint()}`,
        );
      }

      throw new Error(`Failed to stop workspace container '${containerName}'.`);
    }

    // Listing containers failed mid-stop: the container may still be running,
    // so surface the failure rather than report a stop that never happened.
    if (state === 'unknown') {
      throw new Error(couldNotDetermineStateMessage(containerName));
    }

    if (state === 'stopped') {
      try {
        deps.deleteContainer(containerName);
      } catch {
        // Best effort only. A later start may still succeed if the container disappears.
      }
    }
  };

  return { stopAndRemoveContainer };
}

const defaultApi = createContainerLifecycle();

export const stopAndRemoveContainer = defaultApi.stopAndRemoveContainer;
