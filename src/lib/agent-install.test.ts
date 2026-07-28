import { describe, test, expect } from 'bun:test';
import {
  planAgentInstalls,
  runAgentInstallStep,
  type AgentInstallDeps,
  type AgentInstallProbe,
} from './agent-install.js';
import { nativeInstallTargets } from './agents.js';
import type { NativeInstallTarget } from './agents.js';
import type { ProgressOutput } from './sync-progress.js';

// Real KNOWN_AGENTS entries, so a change to the table's install shape
// (installedPath in particular) surfaces here rather than against a fixture.
const NATIVE_TARGETS = nativeInstallTargets([
  { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
  { name: 'OpenCode', package: 'opencode-ai@latest' },
]);

function nativeTarget(binary: string): NativeInstallTarget {
  const target = NATIVE_TARGETS.find((candidate) => candidate.binary === binary);
  if (target === undefined) {
    throw new Error(`KNOWN_AGENTS no longer has a native '${binary}' agent`);
  }
  return target;
}

const CLAUDE = nativeTarget('claude');
const OPENCODE = nativeTarget('opencode');

describe('planAgentInstalls', () => {
  test('agents that probe absent are installed, in order', () => {
    expect(planAgentInstalls([
      { target: CLAUDE, probe: 'absent' },
      { target: OPENCODE, probe: 'installed' },
    ])).toEqual({ kind: 'install', targets: [CLAUDE] });
  });

  test('all installed means nothing to do', () => {
    expect(planAgentInstalls([{ target: CLAUDE, probe: 'installed' }]))
      .toEqual({ kind: 'skip', reason: 'nothing-to-install' });
  });

  test('no native agents means nothing to do', () => {
    expect(planAgentInstalls([])).toEqual({ kind: 'skip', reason: 'nothing-to-install' });
  });

  // A probe timeout means the runtime just failed a 5s command; answering
  // that with a ten-minute install would queue a doomed wait. It must not be
  // confused with 'absent', which triggers exactly that install.
  test('an unavailable probe skips the whole step, even alongside an absent agent', () => {
    expect(planAgentInstalls([
      { target: CLAUDE, probe: 'absent' },
      { target: OPENCODE, probe: 'unavailable' },
    ])).toEqual({ kind: 'skip', reason: 'probe-unavailable' });
  });
});

function silentOutput(): ProgressOutput {
  return { isTTY: false, write: (): void => {} };
}

interface Harness {
  deps: AgentInstallDeps;
  installed: string[];
  warnings: string[];
  infos: string[];
  probedPaths: string[];
}

function createHarness(options: {
  probe?: (containerPath: string) => AgentInstallProbe;
  install?: (target: NativeInstallTarget) => Promise<void>;
  lockHeldFor?: string[];
  lockThrowsFor?: string[];
} = {}): Harness {
  const installed: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const probedPaths: string[] = [];
  const lockHeldFor = options.lockHeldFor ?? [];

  return {
    installed,
    warnings,
    infos,
    probedPaths,
    deps: {
      probe: (containerPath): AgentInstallProbe => {
        probedPaths.push(containerPath);
        return options.probe?.(containerPath) ?? 'absent';
      },
      install: async (target): Promise<void> => {
        if (options.install !== undefined) {
          await options.install(target);
        }
        installed.push(target.binary);
      },
      tryWithInstallLock: async <T>(
        _workspaceName: string,
        binary: string,
        fn: () => Promise<T>,
      ): Promise<T | null> => {
        if (options.lockThrowsFor?.includes(binary) === true) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return lockHeldFor.includes(binary) ? null : await fn();
      },
      warn: (message): void => { warnings.push(message); },
      info: (message): void => { infos.push(message); },
      out: silentOutput(),
      now: () => 0,
    },
  };
}

const BASE = { workspaceName: 'demo', containerName: 'pi-tin-demo', user: 'dev' };

function abortError(): Error {
  return Object.assign(new Error("'container' was interrupted"), { code: 'EABORTED' });
}

function timeoutError(): Error {
  return Object.assign(new Error("'container' timed out after 600000ms"), { code: 'ETIMEDOUT' });
}

describe('runAgentInstallStep', () => {
  test('probes the launcher path in the container home and installs what is missing', async () => {
    const harness = createHarness();

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    // `test -x` on the launcher, not the versions dir: a dangling symlink or
    // a lost exec bit must read as "not installed" and self-heal.
    expect(harness.probedPaths).toEqual([
      '/home/dev/.local/bin/claude',
      '/home/dev/.opencode/bin/opencode',
    ]);
    expect(harness.installed).toEqual(['claude', 'opencode']);
    expect(harness.warnings).toEqual([]);
  });

  test('an already-installed agent costs one probe and no install', async () => {
    const harness = createHarness({ probe: () => 'installed' });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual([]);
  });

  test('no native agents does nothing at all', async () => {
    const harness = createHarness();

    await runAgentInstallStep({ ...BASE, targets: [] }, harness.deps);

    expect(harness.probedPaths).toEqual([]);
    expect(harness.installed).toEqual([]);
  });

  // A timed-out probe means the runtime is unresponsive; probing the next
  // agent would just queue another doomed 5s wait.
  test('a probe timeout warns, stops probing, and installs nothing', async () => {
    const harness = createHarness({ probe: () => 'unavailable' });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.probedPaths).toEqual(['/home/dev/.local/bin/claude']);
    expect(harness.installed).toEqual([]);
    expect(harness.warnings).toEqual([
      "Warning: could not check the installed agents in workspace 'demo' (the probe timed out) — skipping agent installs for this open.",
    ]);
  });

  // Lock-held is another pi-tin open doing the work, not a failure: warning
  // about it would teach users to distrust a healthy concurrent open.
  test('a held lock informs rather than warns, and later agents still install', async () => {
    const harness = createHarness({ lockHeldFor: ['claude'] });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual(['opencode']);
    expect(harness.warnings).toEqual([]);
    expect(harness.infos).toEqual([
      'Another pi-tin open is installing Claude Code — continuing without it.',
    ]);
  });

  // Lock I/O is the one failure outside the installer's own error handling
  // (unwritable state dir, disk full); it must not cost the user their open.
  test('a lock that cannot be taken warns instead of throwing', async () => {
    const harness = createHarness({ lockThrowsFor: ['claude'] });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual(['opencode']);
    expect(harness.warnings).toEqual([
      'Warning: could not start the Claude Code install — continuing without it; pi-tin retries on the next open. EACCES: permission denied',
    ]);
  });

  test('a failed install warns with the installer error and the later agent still installs', async () => {
    const harness = createHarness({
      install: (target): Promise<void> =>
        target.binary === 'claude'
          ? Promise.reject(new Error("'container' exited with status 1: curl: (6) Could not resolve host"))
          : Promise.resolve(),
    });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual(['opencode']);
    expect(harness.warnings).toEqual([
      "Warning: Claude Code install failed — continuing without it; pi-tin retries on the next open. 'container' exited with status 1: curl: (6) Could not resolve host",
    ]);
  });

  test('a timed-out install names the deadline and warns the guest installer may still run', async () => {
    const harness = createHarness({
      install: (target): Promise<void> =>
        target.binary === 'claude' ? Promise.reject(timeoutError()) : Promise.resolve(),
    });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual(['opencode']);
    expect(harness.warnings).toEqual([
      'Warning: Claude Code install timed out after 10m — continuing without it; pi-tin retries on the next open. The in-container installer may still be running.',
    ]);
  });

  // ^C means "stop waiting", so it abandons the whole step — not just this
  // agent, which would leave the user waiting again on the next one. The open
  // itself continues to the shell (the caller never sees a throw).
  test('^C during an install abandons the step without failing the open', async () => {
    const harness = createHarness({
      install: (target): Promise<void> =>
        target.binary === 'claude' ? Promise.reject(abortError()) : Promise.resolve(),
    });

    await runAgentInstallStep({ ...BASE, targets: NATIVE_TARGETS }, harness.deps);

    expect(harness.installed).toEqual([]);
    expect(harness.warnings).toEqual([
      'Warning: Claude Code install aborted — pi-tin retries it on the next open.',
    ]);
  });
});
