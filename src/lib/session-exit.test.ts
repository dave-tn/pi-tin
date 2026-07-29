import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SESSION_TERMINATION_SIGNALS,
  guardSessionExit,
  type SessionExitDeps,
  type SessionTerminationSignal,
} from './session-exit.js';

// Stands in for the process signal table so a handler can be driven without
// raising a real signal at the test runner. Listener order is preserved, as
// the real emit order is what the guard's design turns on.
function fakeProcess(): {
  deps: SessionExitDeps;
  armed: () => SessionTerminationSignal[];
  emit: (signal: SessionTerminationSignal) => void;
  raised: SessionTerminationSignal[];
} {
  const listeners = new Map<SessionTerminationSignal, Array<() => void>>();
  const raised: SessionTerminationSignal[] = [];
  return {
    deps: {
      addListener: (signal, listener) => {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      removeListener: (signal, listener) => {
        const remaining = (listeners.get(signal) ?? []).filter((entry) => entry !== listener);
        if (remaining.length === 0) listeners.delete(signal);
        else listeners.set(signal, remaining);
      },
      raise: (signal) => {
        raised.push(signal);
      },
    },
    armed: () => [...listeners.keys()],
    emit: (signal) => {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
    raised,
  };
}

describe('guardSessionExit', () => {
  // ^C must keep meaning "abort the step in progress" — the agent install
  // continues to the shell — so SIGINT must never be claimed here.
  test('arms the deliberate-termination signals and leaves SIGINT alone', () => {
    const fake = fakeProcess();
    guardSessionExit(() => {}, fake.deps);

    expect(fake.armed().sort()).toEqual(['SIGHUP', 'SIGQUIT', 'SIGTERM']);
    expect(SESSION_TERMINATION_SIGNALS).not.toContain('SIGINT');
  });

  test('a signal runs the close-out, then re-raises to terminate pi-tin', () => {
    const fake = fakeProcess();
    let closed = 0;
    guardSessionExit(() => { closed += 1; }, fake.deps);

    fake.emit('SIGHUP');

    expect(closed).toBe(1);
    expect(fake.raised).toEqual(['SIGHUP']);
  });

  // The close-out must be complete before the re-raise, or the workspace is
  // stranded exactly as it was before this guard existed. Ordering is the
  // whole point, so pin it rather than the two facts separately.
  test('the close-out completes before the re-raise', () => {
    const fake = fakeProcess();
    const order: string[] = [];
    guardSessionExit(() => { order.push('closed'); }, {
      ...fake.deps,
      raise: (signal) => { order.push(`raised ${signal}`); },
    });

    fake.emit('SIGTERM');

    expect(order).toEqual(['closed', 'raised SIGTERM']);
  });

  // Dropping the listeners is what makes the re-raise fatal rather than a
  // loop back into this same handler.
  test('a signal disarms the guard before re-raising', () => {
    const fake = fakeProcess();
    guardSessionExit(() => {
      expect(fake.armed()).toEqual([]);
    }, fake.deps);

    fake.emit('SIGQUIT');

    expect(fake.armed()).toEqual([]);
  });

  test('a failing close-out still re-raises so the signal terminates pi-tin', () => {
    const fake = fakeProcess();
    guardSessionExit(() => {
      throw new Error('runtime state unwritable');
    }, fake.deps);

    fake.emit('SIGHUP');

    expect(fake.raised).toEqual(['SIGHUP']);
  });

  test('releasing disarms every signal so later ones are not claimed', () => {
    const fake = fakeProcess();
    let closed = 0;
    const release = guardSessionExit(() => { closed += 1; }, fake.deps);

    release();
    expect(fake.armed()).toEqual([]);

    fake.emit('SIGTERM');
    expect(closed).toBe(0);
  });

  test('the default deps arm and disarm real process listeners', () => {
    const before = process.listenerCount('SIGHUP');
    const release = guardSessionExit(() => {});

    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    release();
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});

// The regression, end to end in a real process: `pi-tin open` spends its
// longest pre-attach stretch inside spawnProcessGroupWithDeadline (the
// workspace-state copy-in, the ~250 MB native-agent install), which answers a
// terminating signal by settling its own listeners and re-raising it. A guard
// whose close-out is not finished by then is killed with nothing done — the
// exact shape of issue #29 — and no in-process fake can show that, because it
// is the runtime's own signal delivery doing the killing.
describe('guardSessionExit under a real signal', () => {
  const script = (markerPath: string): string => `
import fs from 'node:fs';
import { guardSessionExit } from '${path.join(import.meta.dir, 'session-exit.ts')}';
import { spawnProcessGroupWithDeadline } from '${path.join(import.meta.dir, 'container.ts')}';

guardSessionExit(() => { fs.writeFileSync(${JSON.stringify(markerPath)}, 'armed'); });
await spawnProcessGroupWithDeadline('sleep', ['30'], { timeoutMs: 60000, onInterrupt: 'die' });
`;

  test('closes the session out even with a spawn wrapper re-raising the signal', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-signal-'));
    const markerPath = path.join(tmpDir, 'closed');
    const scriptPath = path.join(tmpDir, 'open.ts');
    fs.writeFileSync(scriptPath, script(markerPath));

    try {
      const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => { child.on('exit', (code, signal) => { resolve({ code, signal }); }); },
      );

      // Long enough for the child to reach the spawn wrapper — the window the
      // guard exists to cover — but far inside the 30s sleep it is blocked on.
      await Bun.sleep(1_500);
      child.kill('SIGHUP');
      const exit = await exited;

      expect(fs.existsSync(markerPath)).toBe(true);
      // 129 (or a bare SIGHUP death) is the point: the guard closes the
      // session out and still lets the signal take pi-tin down.
      expect(exit.code === 129 || exit.signal === 'SIGHUP').toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});
