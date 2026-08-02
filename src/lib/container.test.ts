import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  containerNameFor,
  imageTagFor,
  workspaceNameLengthError,
  isPiTinContainerId,
  workspaceNameFromContainerId,
  isPiTinImageTag,
  workspaceNameFromImageTag,
  partitionEnvForFile,
  parseContainerListOutput,
  parseImageListOutput,
  listContainers,
  listImageNames,
  getContainerState,
  getContainerIpv4,
  streamToContainer,
  streamFromContainer,
  copyFromContainer,
  execContainerCommand,
  execContainerCommandOutput,
  stopContainer,
  killContainer,
  deleteContainer,
  isContainerSubprocessAborted,
  isContainerSubprocessTimeout,
  spawnContainerCopy,
  spawnProcessGroupWithDeadline,
  type ContainerSubprocessRunner,
  type ContainerCopyRunner,
} from './container.js';

function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.error = original;
  }
}

describe('workspace naming helpers', () => {
  test('container name round-trips back to the workspace name', () => {
    const containerName = containerNameFor('my-ws');
    expect(containerName).toBe('pi-tin-my-ws');
    expect(isPiTinContainerId(containerName)).toBe(true);
    expect(workspaceNameFromContainerId(containerName)).toBe('my-ws');
  });

  test('image tag round-trips back to the workspace name', () => {
    const imageTag = imageTagFor('my-ws');
    expect(imageTag).toBe('pi-tin-my-ws');
    expect(isPiTinImageTag(imageTag)).toBe(true);
    expect(workspaceNameFromImageTag(imageTag)).toBe('my-ws');
  });

  test('unrelated ids are not recognised and pass through unchanged', () => {
    expect(isPiTinContainerId('postgres')).toBe(false);
    expect(workspaceNameFromContainerId('postgres')).toBe('postgres');
    expect(isPiTinImageTag('node:slim')).toBe(false);
    expect(workspaceNameFromImageTag('node:slim')).toBe('node:slim');
  });
});

describe('workspaceNameLengthError', () => {
  // The runtime rejects a 64-character container name, so the longest workspace
  // name that still works is 63 minus the prefix. Spelled out rather than
  // derived from the constants so a change to either is caught here.
  const longestValid = 'a'.repeat(56);

  test('accepts the longest name that still fits the container name limit', () => {
    expect(containerNameFor(longestValid)).toHaveLength(63);
    expect(workspaceNameLengthError(longestValid)).toBeNull();
  });

  test('rejects one character beyond the limit', () => {
    const tooLong = `${longestValid}a`;
    expect(containerNameFor(tooLong)).toHaveLength(64);

    const error = workspaceNameLengthError(tooLong);
    expect(error).not.toBeNull();
    expect(error).toContain(tooLong);
    expect(error).toContain('64');
    expect(error).toContain('63');
    expect(error).toContain('56');
  });

  test('accepts ordinary names', () => {
    expect(workspaceNameLengthError('my-ws')).toBeNull();
  });
});

describe('partitionEnvForFile', () => {
  test('keeps single-line values', () => {
    const { safe, skipped } = partitionEnvForFile({
      FOO: 'bar',
      EMPTY: '',
      WITH_EQUALS: 'a=b=c',
      HASH: '#notacomment',
    });
    expect(safe).toEqual({
      FOO: 'bar',
      EMPTY: '',
      WITH_EQUALS: 'a=b=c',
      HASH: '#notacomment',
    });
    expect(skipped).toEqual([]);
  });

  test('skips values containing newlines or carriage returns', () => {
    const pem = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----';
    const { safe, skipped } = partitionEnvForFile({
      GOOD: 'token',
      PEM: pem,
      CRLF: 'a\r\nb',
    });
    expect(safe).toEqual({ GOOD: 'token' });
    expect(skipped).toEqual(['PEM', 'CRLF']);
  });

  test('skips values with the same exotic separators the parser splits on', () => {
    // Build values from explicit code points so the test does not rely on
    // literal control characters surviving in the source file.
    const sep = (code: number): string => `a${String.fromCharCode(code)}b`;
    const { safe, skipped } = partitionEnvForFile({
      VT: sep(0x0b),
      FF: sep(0x0c),
      NEL: sep(0x85),
      LS: sep(0x2028),
      PS: sep(0x2029),
      OK: 'plain',
    });
    expect(safe).toEqual({ OK: 'plain' });
    expect(skipped.sort()).toEqual(['FF', 'LS', 'NEL', 'PS', 'VT']);
  });

  test('returns empty partitions for empty input', () => {
    expect(partitionEnvForFile({})).toEqual({ safe: {}, skipped: [] });
  });
});

describe('listContainers failure signalling', () => {
  test('returns null and warns when the container CLI fails', () => {
    const { result, warnings } = withCapturedWarnings(() =>
      listContainers(() => {
        throw new Error('connection refused');
      }));
    expect(result).toBeNull();
    expect(warnings.join('\n')).toContain('failed to list containers');
    expect(warnings.join('\n')).toContain('connection refused');
  });

  test('returns null and warns when list output is not valid JSON', () => {
    const { result, warnings } = withCapturedWarnings(() =>
      listContainers(() => 'not-json'));
    expect(result).toBeNull();
    expect(warnings.join('\n')).toContain('failed to parse container list output');
  });

  test('getContainerState reports unknown when containers cannot be listed', () => {
    const { result } = withCapturedWarnings(() =>
      getContainerState('pi-tin-demo', () => {
        throw new Error('boom');
      }));
    expect(result).toBe('unknown');
  });

  test('getContainerState still resolves real states from list output', () => {
    const listJson = JSON.stringify([{ id: 'pi-tin-demo', status: { state: 'running' } }]);
    expect(getContainerState('pi-tin-demo', () => listJson)).toBe('running');
    expect(getContainerState('pi-tin-ghost', () => listJson)).toBe('not-found');
  });

  test('getContainerIpv4 strips the CIDR suffix off the first attached network', () => {
    const listJson = JSON.stringify([{
      id: 'pi-tin-demo',
      status: { state: 'running', networks: [{ ipv4Address: '192.168.64.5/24' }] },
    }]);
    expect(getContainerIpv4('pi-tin-demo', () => listJson)).toBe('192.168.64.5');
  });

  test('getContainerIpv4 is null for an unaddressed, unlisted, or unlistable container', () => {
    const listJson = JSON.stringify([{ id: 'pi-tin-demo', status: { state: 'stopped' } }]);
    expect(getContainerIpv4('pi-tin-demo', () => listJson)).toBeNull();
    expect(getContainerIpv4('pi-tin-ghost', () => listJson)).toBeNull();

    const { result } = withCapturedWarnings(() =>
      getContainerIpv4('pi-tin-demo', () => {
        throw new Error('boom');
      }));
    expect(result).toBeNull();
  });
});

describe('listImageNames failure signalling', () => {
  test('returns an empty list and warns when the container CLI fails', () => {
    const { result, warnings } = withCapturedWarnings(() =>
      listImageNames(() => {
        throw new Error('connection refused');
      }));
    expect(result).toEqual([]);
    expect(warnings.join('\n')).toContain('failed to list images');
    expect(warnings.join('\n')).toContain('connection refused');
  });

  test('returns an empty list and warns when image list output is not valid JSON', () => {
    const { result, warnings } = withCapturedWarnings(() =>
      listImageNames(() => 'not-json'));
    expect(result).toEqual([]);
    expect(warnings.join('\n')).toContain('failed to parse image list output');
  });

  test('still parses names from valid output', () => {
    const listJson = JSON.stringify([
      { configuration: { name: 'pi-tin-demo:latest' } },
    ]);
    expect(listImageNames(() => listJson)).toEqual(['pi-tin-demo']);
  });
});

describe('bounded container subprocess options', () => {
  const boundedOptions = {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5_000,
    killSignal: 'SIGKILL',
    // Node's 1 MiB default would throw ENOBUFS on the largest capture here —
    // a guest `dmesg` after an OOM kill, exactly the case it is read for.
    maxBuffer: 64 * 1024 * 1024,
  };

  interface CapturedCall {
    file: string;
    args: string[];
    options: unknown;
  }

  function createRunCapture(): {
    calls: CapturedCall[];
    run: ContainerSubprocessRunner;
  } {
    const calls: CapturedCall[] = [];
    return {
      calls,
      run: (file, args, options): void => {
        calls.push({ file, args, options });
      },
    };
  }

  function createCopyRunCapture(): {
    calls: CapturedCall[];
    run: ContainerCopyRunner;
  } {
    const calls: CapturedCall[] = [];
    return {
      calls,
      run: (file, args, options): Promise<void> => {
        calls.push({ file, args, options });
        return Promise.resolve();
      },
    };
  }

  test('streamToContainer pipes a host tar into container exec as the target user, bounded by default', async () => {
    const { calls, run } = createCopyRunCapture();
    await streamToContainer({
      name: 'pi-tin-demo',
      hostPath: '/tmp/host-state/.zsh_history',
      containerPath: '/home/dev/.zsh_history',
      user: 'dev',
      run,
    });
    expect(calls).toEqual([{
      file: '/bin/sh',
      args: [
        '-c',
        'set -o pipefail; COPYFILE_DISABLE=1 tar -cf - --format ustar -C "$1" -- "$2" | ' +
          'container exec --interactive --user "$3" "$4" sh -c \'mkdir -p "$1" && tar -xf - -C "$1"\' sh "$5"',
        'sh',
        '/tmp/host-state',
        '.zsh_history',
        'dev',
        'pi-tin-demo',
        '/home/dev',
      ],
      options: boundedOptions,
    }]);
  });

  test('copyFromContainer is bounded by default', async () => {
    const { calls, run } = createCopyRunCapture();
    await copyFromContainer({
      name: 'pi-tin-demo',
      containerPath: '/home/dev/.zsh_history',
      hostPath: '/tmp/host-state',
      run,
    });
    expect(calls).toEqual([{
      file: 'container',
      args: ['cp', 'pi-tin-demo:/home/dev/.zsh_history', '/tmp/host-state'],
      options: boundedOptions,
    }]);
  });

  // The binary-copy deadline is worthless if it never reaches the subprocess:
  // dropping the timeoutMs pass-through would leave every binary copy on the
  // 5s default and time out in production while the whole suite stays green.
  test('streamToContainer passes an explicit timeoutMs through to the subprocess', async () => {
    const { calls, run } = createCopyRunCapture();
    await streamToContainer({
      name: 'pi-tin-demo',
      hostPath: '/tmp/host-state/.local/bin/herdr',
      containerPath: '/home/dev/.local/bin/herdr',
      user: 'dev',
      timeoutMs: 60_000,
      run,
    });
    expect(calls.map((call) => call.options)).toEqual([{ ...boundedOptions, timeout: 60_000 }]);
  });

  test('copyFromContainer passes an explicit timeoutMs through to the subprocess', async () => {
    const { calls, run } = createCopyRunCapture();
    await copyFromContainer({
      name: 'pi-tin-demo',
      containerPath: '/home/dev/.local/bin/herdr',
      hostPath: '/tmp/host-state',
      timeoutMs: 60_000,
      run,
    });
    expect(calls.map((call) => call.options)).toEqual([{ ...boundedOptions, timeout: 60_000 }]);
  });

  test('streamFromContainer tars the directory contents out through container exec as root', async () => {
    const { calls, run } = createCopyRunCapture();
    await streamFromContainer({
      name: 'pi-tin-demo',
      containerPath: '/home/dev/.local/share/claude',
      hostPath: '/tmp/host-state/.local/share/claude.pi-tin-tmp',
      run,
    });
    expect(calls).toEqual([{
      file: '/bin/sh',
      args: [
        '-c',
        'set -o pipefail; mkdir -p "$2" && ' +
          'container exec --user root "$3" sh -c \'cd "$1" && tar -cf - .\' sh "$1" | ' +
          'tar -xf - -C "$2"',
        'sh',
        '/home/dev/.local/share/claude',
        '/tmp/host-state/.local/share/claude.pi-tin-tmp',
        'pi-tin-demo',
      ],
      options: boundedOptions,
    }]);
  });

  // The deadline is worthless if it never reaches the subprocess: dropping the
  // pass-through would leave every binary copy on the 5s default.
  test('streamFromContainer passes an explicit timeoutMs through to the subprocess', async () => {
    const { calls, run } = createCopyRunCapture();
    await streamFromContainer({
      name: 'pi-tin-demo',
      containerPath: '/home/dev/.local/share/claude',
      hostPath: '/tmp/host-state/claude.pi-tin-tmp',
      timeoutMs: 60_000,
      run,
    });
    expect(calls.map((call) => call.options)).toEqual([{ ...boundedOptions, timeout: 60_000 }]);
  });

  // Without pipefail the pipeline's status is the last command's, so a guest
  // failure that still emits a well-formed (empty) archive exits 0 and a
  // truncated copy would look like a success. This test is intentionally kept
  // even though it cannot fail independently of the two script-assertion
  // tests above: it exists to catch the case where someone drops pipefail
  // from the source *and* updates both pinned script expectations to match
  // (the "just make the tests green" edit) — this is the only test left that
  // would still fail.
  test('both copy pipelines set pipefail', async () => {
    const out = createCopyRunCapture();
    await streamFromContainer({
      name: 'pi-tin-demo',
      containerPath: '/home/dev/.config/herdr',
      hostPath: '/tmp/host-state/.config/herdr.pi-tin-tmp',
      run: out.run,
    });
    const into = createCopyRunCapture();
    await streamToContainer({
      name: 'pi-tin-demo',
      hostPath: '/tmp/host-state/.zsh_history',
      containerPath: '/home/dev/.zsh_history',
      user: 'dev',
      run: into.run,
    });
    for (const calls of [out.calls, into.calls]) {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[1]).toStartWith('set -o pipefail; ');
    }
  });

  test('the default copy runner rejects with an ETIMEDOUT-shaped error on deadline', async () => {
    // `sh -c 'sleep 10'` outlives any deadline on any platform; driving
    // spawnContainerCopy directly (like the signal test below) keeps this off
    // the real `container` pipeline, which does not exist on CI hosts.
    const sigintListenersBefore = process.listenerCount('SIGINT');
    let caught: unknown;
    try {
      await spawnContainerCopy('sh', ['-c', 'sleep 10'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 1,
        killSignal: 'SIGKILL',
        maxBuffer: 1_048_576,
      });
    } catch (error) {
      caught = error;
    }
    expect(isContainerSubprocessTimeout(caught)).toBe(true);
    expect((caught as Error).message).toBe("'sh' timed out after 1ms");
    // The copy runs detached, so it installs interrupt forwarders for its
    // lifetime. Leaking them would accumulate across every entry of every
    // sync until Node warns about MaxListeners — pin that they are removed.
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
  });

  test('the default copy runner names the fatal signal when the subprocess dies signalled', async () => {
    let caught: unknown;
    try {
      await spawnContainerCopy('sh', ['-c', 'kill -TERM $$'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1_048_576,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("'sh' was killed by SIGTERM");
  });

  // The agent-install step runs on this path with onInterrupt: 'abort'. Its
  // whole point is that ^C skips the install and the open continues, so the
  // rejection must be distinguishable from a timeout — which warns about a
  // guest installer possibly still running — and from a plain failure.
  // Driven against `sh` rather than the real `container` binary, which CI
  // hosts do not have; the subject is the interrupt disposition.
  test("onInterrupt 'abort' rejects a ^C as EABORTED, not ETIMEDOUT", async () => {
    const sigintListenersBefore = process.listenerCount('SIGINT');
    let caught: unknown;
    const pending = spawnProcessGroupWithDeadline('sh', ['-c', 'sleep 10'], {
      timeoutMs: 30_000,
      onInterrupt: 'abort',
    }).catch((error: unknown) => { caught = error; });

    await new Promise((resolve) => { setTimeout(resolve, 50); });
    process.kill(process.pid, 'SIGINT');
    await pending;

    // A timeout warns that the guest installer may still be running and a
    // plain failure prints the installer's stderr; an abort must say neither.
    expect(isContainerSubprocessAborted(caught)).toBe(true);
    expect(isContainerSubprocessTimeout(caught)).toBe(false);
    // Both the abort's own early removal and settle() must leave no listener
    // behind, or every install would accumulate one.
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
  });

  test("onInterrupt 'abort' still classifies its own deadline as a timeout", async () => {
    let caught: unknown;
    try {
      await spawnProcessGroupWithDeadline('sh', ['-c', 'sleep 10'], {
        timeoutMs: 1,
        onInterrupt: 'abort',
      });
    } catch (error) {
      caught = error;
    }
    expect(isContainerSubprocessTimeout(caught)).toBe(true);
    expect(isContainerSubprocessAborted(caught)).toBe(false);
  });

  // The session close-out runs on this path. A terminating signal queued
  // behind the interactive attach is delivered exactly when the close-out's
  // first copy is in flight, so 'die' would kill the snapshot the close-out
  // exists to take — 'finish' must let the copy complete instead. A resolved
  // promise is the proof the child survived: a killed child rejects with
  // "was killed by SIGKILL".
  test("onInterrupt 'finish' lets a termination signal pass and the copy complete", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-finish-pass-'));
    const flagPath = path.join(tmpDir, 'flag');
    try {
      const listenersBefore = {
        SIGTERM: process.listenerCount('SIGTERM'),
        SIGHUP: process.listenerCount('SIGHUP'),
      };
      // The child exits only once the flag file appears, so however stalled
      // the timers below get, it cannot finish first — a child gone before
      // the raise would have settled the wrapper, leaving the real SIGTERM
      // to meet the default disposition and kill the whole test run.
      const pending = spawnProcessGroupWithDeadline(
        'sh',
        ['-c', `until [ -e ${flagPath} ]; do sleep 0.05; done`],
        { timeoutMs: 30_000, onInterrupt: 'finish' },
      );

      await new Promise((resolve) => { setTimeout(resolve, 50); });
      process.kill(process.pid, 'SIGTERM');
      // The kill returns before the JS listener runs — the runtime delivers
      // the emit on a later loop turn — so yield before looking at the
      // listeners.
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      // Only its own listener drops — a second SIGTERM must meet the default
      // disposition and quit, while the other termination signals stay
      // claimed until the copy settles.
      expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.SIGTERM);
      expect(process.listenerCount('SIGHUP')).toBe(listenersBefore.SIGHUP + 1);

      // Release the child; resolution is the proof it survived the signal —
      // a killed child would reject with "was killed by SIGKILL".
      fs.writeFileSync(flagPath, 'done');
      await pending;
      expect(process.listenerCount('SIGHUP')).toBe(listenersBefore.SIGHUP);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("onInterrupt 'finish' still classifies its own deadline as a timeout", async () => {
    let caught: unknown;
    try {
      await spawnProcessGroupWithDeadline('sh', ['-c', 'sleep 10'], {
        timeoutMs: 1,
        onInterrupt: 'finish',
      });
    } catch (error) {
      caught = error;
    }
    expect(isContainerSubprocessTimeout(caught)).toBe(true);
  });

  // ^C is not a deliberate-termination signal: an interactive interrupt of a
  // visible close-out keeps meaning "stop now", so 'finish' must leave the
  // SIGINT disposition as 'die' — kill the copy, re-raise, take pi-tin down.
  // Driven in a subprocess because the re-raise is fatal by design.
  test("onInterrupt 'finish' still dies on ^C, copy killed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-finish-sigint-'));
    const markerPath = path.join(tmpDir, 'copied');
    const scriptPath = path.join(tmpDir, 'close-out.ts');
    fs.writeFileSync(scriptPath, `
import { spawnContainerCopyForCloseOut } from '${path.join(import.meta.dir, 'container.ts')}';
await spawnContainerCopyForCloseOut('sh', ['-c', 'sleep 10 && echo done > ${markerPath}'], {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 30_000,
  killSignal: 'SIGKILL',
  maxBuffer: 1_048_576,
});
`);

    try {
      const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => { child.on('exit', (code, signal) => { resolve({ code, signal }); }); },
      );
      await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      child.kill('SIGINT');
      const exit = await exited;

      expect(exit.code === 130 || exit.signal === 'SIGINT').toBe(true);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);

  test('execContainerCommand is bounded by default', () => {
    const { calls, run } = createRunCapture();
    execContainerCommand({
      name: 'pi-tin-demo',
      user: 'root',
      command: ['rm', '-rf', '/home/dev/.zsh_history'],
      run,
    });
    expect(calls).toEqual([{
      file: 'container',
      args: ['exec', '--user', 'root', 'pi-tin-demo', 'rm', '-rf', '/home/dev/.zsh_history'],
      options: boundedOptions,
    }]);
  });

  test('execContainerCommandOutput returns captured stdout, bounded by default', () => {
    const calls: CapturedCall[] = [];
    const output = execContainerCommandOutput({
      name: 'pi-tin-demo',
      user: 'dev',
      command: ['sh', '-c', 'sha256sum /home/dev/.local/bin/herdr'],
      capture: (file, args, options): string => {
        calls.push({ file, args, options });
        return 'abc123  /home/dev/.local/bin/herdr\n';
      },
    });
    expect(output).toBe('abc123  /home/dev/.local/bin/herdr\n');
    expect(calls).toEqual([{
      file: 'container',
      args: ['exec', '--user', 'dev', 'pi-tin-demo', 'sh', '-c', 'sha256sum /home/dev/.local/bin/herdr'],
      options: boundedOptions,
    }]);
  });

  test('execContainerCommandOutput omits --user when no user is given', () => {
    const calls: CapturedCall[] = [];
    execContainerCommandOutput({
      name: 'pi-tin-demo',
      command: ['id', '-u'],
      capture: (file, args, options): string => {
        calls.push({ file, args, options });
        return '0\n';
      },
    });
    expect(calls[0]?.args).toEqual(['exec', 'pi-tin-demo', 'id', '-u']);
  });

  test('stopContainer is bounded by default', () => {
    const { calls, run } = createRunCapture();
    stopContainer('pi-tin-demo', run);
    expect(calls).toEqual([{
      file: 'container',
      args: ['stop', 'pi-tin-demo'],
      options: boundedOptions,
    }]);
  });

  test('killContainer is bounded by default', () => {
    const { calls, run } = createRunCapture();
    killContainer('pi-tin-demo', run);
    expect(calls).toEqual([{
      file: 'container',
      args: ['kill', 'pi-tin-demo'],
      options: boundedOptions,
    }]);
  });

  test('deleteContainer is bounded by default', () => {
    const { calls, run } = createRunCapture();
    deleteContainer('pi-tin-demo', run);
    expect(calls).toEqual([{
      file: 'container',
      args: ['delete', '--force', 'pi-tin-demo'],
      options: boundedOptions,
    }]);
  });
});

describe('Apple container JSON parsing', () => {
  test('parses container list output from container 1.0', () => {
    const output = JSON.stringify([
      {
        id: 'pi-tin-demo',
        status: { state: 'running' },
      },
      {
        id: 'buildkit',
        status: { state: 'stopped' },
      },
    ]);

    expect(parseContainerListOutput(output)).toEqual([
      { id: 'pi-tin-demo', status: 'running', ipv4Address: null },
      { id: 'buildkit', status: 'stopped', ipv4Address: null },
    ]);
  });

  test('parses image list output from container 1.0 and strips :latest', () => {
    const output = JSON.stringify([
      {
        configuration: { name: 'pi-tin-demo:latest' },
      },
      {
        configuration: { name: 'ghcr.io/apple/container-builder-shim/builder:1.0.0' },
      },
    ]);

    expect(parseImageListOutput(output)).toEqual([
      'pi-tin-demo',
      'ghcr.io/apple/container-builder-shim/builder:1.0.0',
    ]);
  });
});
