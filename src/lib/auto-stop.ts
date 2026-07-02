import { containerNameFor, getContainerState, stopContainer, deleteContainer } from './container.js';
import {
  withWorkspaceLock,
  reconcileWorkspaceRuntimeState,
  readShutdown,
  clearWorkspaceRuntimeState,
} from './runtime-state.js';

// Hidden CLI sentinel used to re-invoke pi-tin as a detached auto-stop helper.
export const AUTO_STOP_COMMAND = '__auto-stop-if-idle';

const MAX_TIMER_MS = 2_147_483_647;

async function sleepUntil(deadlineMs: number): Promise<void> {
  while (true) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(remainingMs, MAX_TIMER_MS));
    });
  }
}

export async function runAutoStopHelper(
  workspaceName: string,
  deadlineMs: number,
): Promise<void> {
  await sleepUntil(deadlineMs);

  await withWorkspaceLock(workspaceName, () => {
    const shutdown = readShutdown(workspaceName);
    const runtime = reconcileWorkspaceRuntimeState(workspaceName);
    const containerName = containerNameFor(workspaceName);
    const state = getContainerState(containerName);

    // 'unknown' also lands here: when listing containers fails, do nothing —
    // never stop or clear state based on an unverified container state.
    if (state !== 'running') {
      return;
    }

    if (runtime.runtimeState !== 'ok') {
      return;
    }

    if (runtime.activeSessions.length > 0) {
      return;
    }

    if (!shutdown || shutdown.deadlineMs !== deadlineMs) {
      return;
    }

    // Deliberately not stopAndRemoveContainer: this detached helper runs while holding
    // the workspace lock, so it must stay best-effort — never poll and never throw.
    try {
      stopContainer(containerName);
    } catch {
      // Best effort only.
    }

    const postState = getContainerState(containerName);
    if (postState === 'stopped') {
      try {
        deleteContainer(containerName);
      } catch {
        // Best effort only.
      }
    }

    // Clear only on a confirmed non-running state — an 'unknown' post-state
    // must leave the runtime records for the next invocation to reconcile.
    if (postState === 'stopped' || postState === 'not-found') {
      clearWorkspaceRuntimeState(workspaceName);
    }
  });
}
