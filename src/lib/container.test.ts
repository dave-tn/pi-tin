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
  copyToContainer,
  copyFromContainer,
  execContainerCommand,
  stopContainer,
  killContainer,
  deleteContainer,
  type ContainerSubprocessRunner,
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

  test('copyToContainer is bounded by default', () => {
    const { calls, run } = createRunCapture();
    copyToContainer({
      name: 'pi-tin-demo',
      hostPath: '/tmp/host-state',
      containerPath: '/home/dev/.zsh_history',
      run,
    });
    expect(calls).toEqual([{
      file: 'container',
      args: ['cp', '/tmp/host-state', 'pi-tin-demo:/home/dev/.zsh_history'],
      options: boundedOptions,
    }]);
  });

  test('copyFromContainer is bounded by default', () => {
    const { calls, run } = createRunCapture();
    copyFromContainer({
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
