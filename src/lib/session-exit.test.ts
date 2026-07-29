import { describe, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  SESSION_TERMINATION_SIGNALS,
  guardSessionExit,
  signalExitCode,
  type SessionExitDeps,
  type SessionTerminationSignal,
} from './session-exit.js';

// Stands in for the process signal table so a handler can be fired without
// raising a real signal at the test runner.
function fakeProcess(): {
  deps: SessionExitDeps;
  armed: () => SessionTerminationSignal[];
  raise: (signal: SessionTerminationSignal) => void;
  exitCodes: number[];
} {
  const listeners = new Map<SessionTerminationSignal, () => void>();
  const exitCodes: number[] = [];
  return {
    deps: {
      addListener: (signal, listener) => {
        listeners.set(signal, listener);
      },
      removeListener: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
      exit: (code) => {
        exitCodes.push(code);
      },
    },
    armed: () => [...listeners.keys()],
    raise: (signal) => {
      const listener = listeners.get(signal);
      if (listener === undefined) throw new Error(`no listener armed for ${signal}`);
      listener();
    },
    exitCodes,
  };
}

// The handler exits from a promise chain of its own, so let every queued
// reaction run before asserting on it.
async function flush(): Promise<void> {
  await sleep(0);
}

describe('signalExitCode', () => {
  test('maps each termination signal to the shell 128+n convention', () => {
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGQUIT')).toBe(131);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });
});

describe('guardSessionExit', () => {
  // ^C must keep meaning "abort the step in progress" (the agent install
  // continues to the shell), so SIGINT must never be claimed here.
  test('arms the deliberate-termination signals and leaves SIGINT alone', () => {
    const fake = fakeProcess();
    guardSessionExit(async () => 'closed', fake.deps);

    expect(fake.armed().sort()).toEqual(['SIGHUP', 'SIGQUIT', 'SIGTERM']);
    expect(SESSION_TERMINATION_SIGNALS).not.toContain('SIGINT');
  });

  // The regression: before this guard, SIGHUP mid-open killed pi-tin outright,
  // leaving a registered session and a running container with no auto-stop.
  test('SIGHUP runs the close-out, then exits with the signal code', async () => {
    const fake = fakeProcess();
    let closed = 0;
    const close = guardSessionExit(async () => {
      closed += 1;
      return 'Last session closed.';
    }, fake.deps);

    fake.raise('SIGHUP');
    await flush();

    expect(closed).toBe(1);
    expect(await close()).toBe('Last session closed.');
    expect(fake.exitCodes).toEqual([129]);
  });

  // Both the signal handler and the normal finally reach the close-out; a
  // second run would unregister an already-unregistered session and arm a
  // second auto-stop helper against a workspace it no longer owns.
  test('the close-out runs once and both callers get its message', async () => {
    const fake = fakeProcess();
    let closed = 0;
    const close = guardSessionExit(async () => {
      closed += 1;
      return `close #${closed}`;
    }, fake.deps);

    const fromNormalPath = close();
    fake.raise('SIGTERM');

    expect(await fromNormalPath).toBe('close #1');
    expect(await close()).toBe('close #1');
    expect(closed).toBe(1);
  });

  // A close-out that never finishes (a contended workspace lock) must not
  // leave a process no signal can kill: the first signal restores the default
  // disposition for every signal on its way past.
  test('a signal drops every listener so a repeat reaches the default disposition', () => {
    const fake = fakeProcess();
    guardSessionExit(() => new Promise<string>(() => {}), fake.deps);

    fake.raise('SIGTERM');

    expect(fake.armed()).toEqual([]);
  });

  test('completing the close-out disarms the guard', async () => {
    const fake = fakeProcess();
    const close = guardSessionExit(async () => 'closed', fake.deps);

    await close();

    expect(fake.armed()).toEqual([]);
  });

  // A failed close-out must still let the signal terminate pi-tin, and must
  // still surface to the normal exit path rather than being swallowed.
  test('a failing close-out still exits on the signal and rejects for the caller', async () => {
    const fake = fakeProcess();
    const close = guardSessionExit(async () => {
      throw new Error('workspace lock unwritable');
    }, fake.deps);

    fake.raise('SIGQUIT');
    await expect(close()).rejects.toThrow('workspace lock unwritable');
    await flush();

    expect(fake.exitCodes).toEqual([131]);
    expect(fake.armed()).toEqual([]);
  });

  test('the default deps arm and disarm real process listeners', async () => {
    const before = process.listenerCount('SIGHUP');
    const close = guardSessionExit(async () => 'closed');

    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    expect(await close()).toBe('closed');
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});
