import { describe, test, expect } from 'bun:test';
import {
  containerNameFor,
  imageTagFor,
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
  streamToContainer,
  streamFromContainer,
  copyFromContainer,
  execContainerCommand,
  stopContainer,
  killContainer,
  deleteContainer,
  isContainerSubprocessTimeout,
  spawnContainerCopy,
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
    let caught: unknown;
    try {
      await streamToContainer({
        name: 'pi-tin-demo',
        hostPath: '/nonexistent/never-read',
        containerPath: '/home/dev/never-written',
        user: 'dev',
        timeoutMs: 1,
        // No `run` injected: exercise the real spawn path. The command is the
        // documented `sh -c 'tar … | container exec …'` pipeline; with a 1ms
        // deadline it is killed before doing anything.
      });
    } catch (error) {
      caught = error;
    }
    expect(isContainerSubprocessTimeout(caught)).toBe(true);
  });

  test('the default copy runner names the fatal signal when the subprocess dies signalled', async () => {
    let caught: unknown;
    try {
      await spawnContainerCopy('sh', ['-c', 'kill -TERM $$'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("'sh' was killed by SIGTERM");
  });

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
