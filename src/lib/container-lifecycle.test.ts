import { describe, test, expect } from 'bun:test';
import { createContainerLifecycle, type ContainerLifecycleApi } from './container-lifecycle.js';
import type { ContainerState } from './container.js';

interface Harness {
  api: ContainerLifecycleApi;
  calls: string[];
  setState: (state: ContainerState) => void;
  clockAt: (call: string) => number | undefined;
}

// Fake clock: `sleep` advances `now` instantly, so timeout loops run without
// real timers. State transitions are scripted per test via the hooks.
function createHarness(options: {
  state: ContainerState;
  onStop?: (setState: (state: ContainerState) => void) => void;
  onKill?: (setState: (state: ContainerState) => void) => void;
  onDelete?: () => void;
  onPoll?: (pollCount: number, setState: (state: ContainerState) => void) => void;
}): Harness {
  let state = options.state;
  let clock = 0;
  let polls = 0;
  const calls: string[] = [];
  const clockAtCall = new Map<string, number>();
  const setState = (next: ContainerState): void => {
    state = next;
  };

  const record = (call: string): void => {
    calls.push(call);
    if (!clockAtCall.has(call)) {
      clockAtCall.set(call, clock);
    }
  };

  const api = createContainerLifecycle({
    getContainerState: () => {
      polls += 1;
      options.onPoll?.(polls, setState);
      return state;
    },
    stopContainer: () => {
      record('stop');
      options.onStop?.(setState);
    },
    killContainer: () => {
      record('kill');
      options.onKill?.(setState);
    },
    deleteContainer: () => {
      record('delete');
      options.onDelete?.();
    },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  });

  return { api, calls, setState, clockAt: (call: string) => clockAtCall.get(call) };
}

describe('container-lifecycle', () => {
  test('removes an already-stopped container without stopping it', async () => {
    const harness = createHarness({ state: 'stopped' });

    await harness.api.stopAndRemoveContainer('demo');

    expect(harness.calls).toEqual(['delete']);
  });

  test('does nothing when the container does not exist', async () => {
    const harness = createHarness({ state: 'not-found' });

    await harness.api.stopAndRemoveContainer('demo');

    expect(harness.calls).toEqual([]);
  });

  test('refuses to act when the initial container state is unknown', async () => {
    const harness = createHarness({ state: 'unknown' });

    await expect(harness.api.stopAndRemoveContainer('demo'))
      .rejects.toThrow("Could not determine the state of container 'demo'.");

    expect(harness.calls).toEqual([]);
  });

  test('throws without removing when the state becomes unknown after a stop', async () => {
    const harness = createHarness({
      state: 'running',
      // Listing containers starts failing right after the stop is issued.
      onPoll: (polls, setState) => {
        if (polls >= 2) {
          setState('unknown');
        }
      },
    });

    // Even when forced: an unverified state must never escalate to a kill.
    await expect(harness.api.stopAndRemoveContainer('demo', { force: true }))
      .rejects.toThrow("Could not determine the state of container 'demo'.");

    expect(harness.calls).toEqual(['stop']);
  });

  test('stops a running container and removes it once stopped', async () => {
    const harness = createHarness({
      state: 'running',
      // Stays running for a couple of polls after the stop, then lands.
      onPoll: (polls, setState) => {
        if (polls >= 4) {
          setState('stopped');
        }
      },
    });

    await harness.api.stopAndRemoveContainer('demo');

    expect(harness.calls).toEqual(['stop', 'delete']);
  });

  test('throws without killing when the container will not stop and force is off', async () => {
    const harness = createHarness({ state: 'running' });

    await expect(harness.api.stopAndRemoveContainer('demo'))
      .rejects.toThrow("Failed to stop workspace container 'demo'.");

    expect(harness.calls).toEqual(['stop']);
  });

  test('escalates to kill after the timeout when forced, then removes', async () => {
    const harness = createHarness({
      state: 'running',
      // Only a kill brings this container down.
      onKill: (setState) => {
        setState('stopped');
      },
    });

    await harness.api.stopAndRemoveContainer('demo', { force: true });

    expect(harness.calls).toEqual(['stop', 'kill', 'delete']);
    expect(harness.clockAt('kill')).toBe(5000);
  });

  test('swallows stopContainer errors and lets the state recheck decide', async () => {
    const harness = createHarness({
      state: 'running',
      onStop: () => {
        throw new Error('stop failed');
      },
      // The container stops on its own despite the failed stop call.
      onPoll: (polls, setState) => {
        if (polls >= 2) {
          setState('stopped');
        }
      },
    });

    await harness.api.stopAndRemoveContainer('demo');

    expect(harness.calls).toEqual(['stop', 'delete']);
  });

  test('treats deleteContainer failures as best-effort', async () => {
    const harness = createHarness({
      state: 'stopped',
      onDelete: () => {
        throw new Error('delete failed');
      },
    });

    await expect(harness.api.stopAndRemoveContainer('demo')).resolves.toBeUndefined();
    expect(harness.calls).toEqual(['delete']);
  });
});
