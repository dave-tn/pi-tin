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
  // loop back into this same handler. Recorded rather than asserted in
  // place: the handler runs the close-out
  // inside a catch-all, which would swallow a failing expectation and leave
  // this passing whatever the ordering.
  test('a signal disarms the guard before running the close-out', () => {
    const fake = fakeProcess();
    const armedDuringCloseOut: SessionTerminationSignal[][] = [];
    guardSessionExit(() => { armedDuringCloseOut.push(fake.armed()); }, fake.deps);

    fake.emit('SIGQUIT');

    expect(armedDuringCloseOut).toEqual([[]]);
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
    const guard = guardSessionExit(() => { closed += 1; }, fake.deps);

    guard.release();
    expect(fake.armed()).toEqual([]);

    fake.emit('SIGTERM');
    expect(closed).toBe(0);
  });

  // Closing the terminal window while attached queues the signal behind the
  // attach's blocking spawnSync, so it arrives once the normal close-out has
  // already begun. Cutting that short would drop the workspace-state snapshot
  // it takes and the cut-down close-out does not.
  test('after hand-over a signal lets the normal close-out finish', () => {
    const fake = fakeProcess();
    const guard = guardSessionExit(() => {}, fake.deps);

    guard.handOver();
    fake.emit('SIGHUP');

    expect(fake.raised).toEqual([]);
    // Still disarmed, so a second signal quits rather than being swallowed too.
    expect(fake.armed()).toEqual([]);
  });

  // The normal close-out snapshots workspace state before it arms anything,
  // and that snapshot is itself a spawn wrapper which answers this same signal
  // by re-raising it against the default disposition just restored. Dying
  // there lands after the session record is gone and before the countdown is
  // armed — the stranding this guard exists to prevent — so the cut-down
  // close-out runs as insurance even when the normal one owns the exit.
  test('hand-over still arms, in case the close-out it defers to is killed', () => {
    const fake = fakeProcess();
    let closed = 0;
    const guard = guardSessionExit(() => { closed += 1; }, fake.deps);

    guard.handOver();
    fake.emit('SIGTERM');

    expect(closed).toBe(1);
  });

  test('the default deps arm and disarm real process listeners', () => {
    const before = process.listenerCount('SIGHUP');
    const guard = guardSessionExit(() => {});

    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    guard.release();
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

  // The terminal-hangup shape end to end: SIGHUP to the whole process group —
  // the CLI and its blocking attach child together, exactly what closing the
  // terminal window delivers. The attach dies, the queued signal can only be
  // emitted at the close-out copy's first await (nothing before it turns the
  // event loop), and at that moment two listeners hold SIGHUP: the guard's,
  // which arms the insurance and defers (handed over), and the copy wrapper's.
  // With the wrapper on the close-out's 'finish' disposition the copy — the
  // snapshot — must survive that emit and the close-out must run to the end.
  const closeOutScript = (dir: string): string => `
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { guardSessionExit } from '${path.join(import.meta.dir, 'session-exit.ts')}';
import { spawnContainerCopyForCloseOut } from '${path.join(import.meta.dir, 'container.ts')}';

const guard = guardSessionExit(() => { fs.writeFileSync('${dir}/armed', 'armed'); });
try {
  // The attach: blocking, sharing this process's group like the real one.
  spawnSync('sleep', ['10'], { stdio: 'inherit' });
} finally {
  guard.handOver();
  // The synchronous stretch before the copy (the container-state probe).
  execFileSync('sleep', ['0.3']);
  await spawnContainerCopyForCloseOut('sh', ['-c', 'sleep 2 && echo snap > ${dir}/snapshot'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 1_048_576,
  });
  guard.release();
}
`;

  test('a group SIGHUP during the attach still gets the snapshot home', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-group-signal-'));
    const scriptPath = path.join(tmpDir, 'close-out.ts');
    fs.writeFileSync(scriptPath, closeOutScript(tmpDir));

    try {
      // detached: its own process group, standing in for the pty's foreground
      // group, so the negative-pid kill reaches the CLI and the attach child
      // and nothing else.
      const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: true });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => { child.on('exit', (code, signal) => { resolve({ code, signal }); }); },
      );

      await Bun.sleep(1_500);
      const pid = child.pid;
      expect(pid).toBeDefined();
      if (pid !== undefined) process.kill(-pid, 'SIGHUP');
      const exit = await exited;

      // The insurance arm ran at the emit, the copy survived it, and the
      // close-out completed — nothing re-raised, so the exit is clean.
      expect(fs.existsSync(path.join(tmpDir, 'armed'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot'))).toBe(true);
      expect(exit.code).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});
