import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  planWorkspaceOpen,
  planRestartIfIdle,
  planAddProject,
  planImageBuild,
  planBuildFailureFallback,
  planAttachPreflight,
  planHerdrAttach,
  planAutoStopDecision,
  type HerdrAgentStates,
} from './workspace-plans.js';
import { openWorkspace, countSharedDirectories, computeRuntimeStartPlan, loginShellCommand, resolveOpenPlan, statePathsForCopyIn, statePathsForCopyOut, snapshotThenRemoveContainer, type RestartTeardownDeps } from './open.js';
import { validateContainerProfile, validateWorkspace } from './validators.js';
import { resolveResources } from './resources.js';
import { containerNameFor, imageTagFor } from './container.js';
import { containerHomeDir, getHostGhConfigDir } from './paths.js';
import { CliError, EXIT } from './cli-errors.js';

describe('openWorkspace workspace loading errors', () => {
  let tmpDir: string;
  let wsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pi-tin', 'config.yaml'), 'shell: zsh\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  async function captureRejection(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
      throw new Error(`Expected an Error rejection, got: ${String(error)}`);
    }
    throw new Error('Expected promise to reject');
  }

  test('surfaces schema errors naming the field instead of "not found"', async () => {
    fs.writeFileSync(
      path.join(wsDir, 'bad.yaml'),
      'profile: node-dev\nprojects: not-an-array\n',
    );

    const error = await captureRejection(openWorkspace('bad', {}));
    expect(error.message).toContain('Invalid workspace configuration');
    expect(error.message).toContain('projects');
    expect(error.message).not.toContain('not found');
  });

  test('surfaces YAML syntax errors instead of "not found"', async () => {
    fs.writeFileSync(path.join(wsDir, 'bad.yaml'), 'profile: [unclosed\n');

    const error = await captureRejection(openWorkspace('bad', {}));
    expect(error.message).toContain('Failed to parse YAML');
    expect(error.message).not.toContain('not found');
  });

  test('surfaces the name rule for invalid names instead of "not found"', async () => {
    const error = await captureRejection(openWorkspace('MyWS', {}));
    expect(error.message).toContain("Invalid workspace name 'MyWS'");
    expect(error.message).toContain('lowercase');
    expect(error.message).not.toContain('not found');
  });

  test('reports "not found" as CliError(NOT_FOUND) when no workspaces are configured', async () => {
    const error = await captureRejection(openWorkspace('ghost', {}));
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error('unreachable');
    expect(error.exitCode).toBe(EXIT.NOT_FOUND);
    expect(error.message).toBe("Workspace 'ghost' not found — no workspaces configured.");
  });

  test('reports "not found" with available workspaces when others exist', async () => {
    fs.writeFileSync(
      path.join(wsDir, 'good.yaml'),
      'profile: node-dev\nprojects: []\n',
    );

    const error = await captureRejection(openWorkspace('ghost', {}));
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error('unreachable');
    expect(error.exitCode).toBe(EXIT.NOT_FOUND);
    expect(error.message).toBe("Workspace 'ghost' not found. Available: good");
  });
});

describe('countSharedDirectories', () => {
  let tmpDir: string;
  let wsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pi-tin', 'config.yaml'), 'shell: zsh\n');
    // node-dev is synced into the temp profiles dir by ensureInitialised.
    fs.writeFileSync(
      path.join(wsDir, 'good.yaml'),
      'profile: node-dev\nprojects: []\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('counts each project as a distinct mount', () => {
    const oneProject = countSharedDirectories('good', ['/tmp/proj-a']);
    const twoProjects = countSharedDirectories('good', ['/tmp/proj-a', '/tmp/proj-b']);
    expect(twoProjects).toBe(oneProject + 1);
  });
});

describe('computeRuntimeStartPlan', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  // Joining an already-running workspace computes this plan purely for the
  // drift hash — mount messages must be collected as notices, not printed.
  test('collects mount notices instead of logging', () => {
    const projectDir = path.join(tmpDir, 'proj-a');
    fs.mkdirSync(projectDir, { recursive: true });
    const missingMount = path.join(tmpDir, 'missing');

    const workspace = validateWorkspace({
      profile: 'node-dev',
      projects: [projectDir],
      tmux: { mode: 'isolated' },
      host: {
        mounts: [{ host: missingMount, container: '/mnt/extra', readonly: false }],
      },
    });
    const containerProfile = validateContainerProfile({
      description: 'fixture',
      base_image: 'node:22',
      user: 'dev',
    });

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtimePlan = computeRuntimeStartPlan({
        wsName: 'demo',
        containerName: containerNameFor('demo'),
        imageTag: imageTagFor('demo'),
        workspace,
        containerProfile,
        resources: resolveResources(containerProfile),
      });

      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(runtimePlan.notices).toContainEqual({
        kind: 'warning',
        text: `Skipping host mount (path does not exist): ${missingMount}`,
      });
      expect(runtimePlan.notices.some(
        (notice) => notice.kind === 'info' && notice.text.startsWith('tmux workspace config mounted from'),
      )).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('computeRuntimeStartPlan sshd', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  const planFor = (workspaceExtra: Record<string, unknown>): ReturnType<typeof computeRuntimeStartPlan> => {
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const workspace = validateWorkspace({
      profile: 'node-dev',
      projects: [projectDir],
      ...workspaceExtra,
    });
    const containerProfile = validateContainerProfile({
      description: 'fixture',
      base_image: 'node:22',
      user: 'dev',
    });
    return computeRuntimeStartPlan({
      wsName: 'demo',
      containerName: containerNameFor('demo'),
      imageTag: imageTagFor('demo'),
      workspace,
      containerProfile,
      resources: resolveResources(containerProfile),
    });
  };

  test('sshd swaps the container command to the launcher and changes the runtime hash', () => {
    const plain = planFor({});
    const withSshd = planFor({ sshd: true });

    expect(plain.sshdEnabled).toBe(false);
    expect(plain.command[0]).toBe('/bin/sh');
    expect(withSshd.sshdEnabled).toBe(true);
    expect(withSshd.command).toEqual(['/usr/local/bin/pi-tin-sshd-launch']);
    expect(withSshd.runtimeHash).not.toBe(plain.runtimeHash);
  });

  test('attach: herdr alone enables sshd', () => {
    expect(planFor({ attach: 'herdr' }).sshdEnabled).toBe(true);
  });

  // The host dirs are created only when a container actually starts, so
  // resolving a plan for a join (or a refusal) leaves no empty state dirs
  // behind.
  test('attach: herdr mounts the herdr state dir and the server bin dir, creating neither', () => {
    const runtimePlan = planFor({ attach: 'herdr' });

    const stateRoot = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    expect(runtimePlan.volumes).toContainEqual({
      host: path.join(stateRoot, '.config', 'herdr'),
      container: '/home/dev/.config/herdr',
    });
    expect(runtimePlan.volumes).toContainEqual({
      host: path.join(stateRoot, '.local', 'bin'),
      container: '/home/dev/.local/bin',
    });
    expect(runtimePlan.managedStateMountPaths).toEqual(['.local/bin', '.config/herdr']);
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  test('shell attach without native agents gets no managed mounts', () => {
    const runtimePlan = planFor({ sshd: true });
    expect(runtimePlan.managedStateMountPaths).toEqual([]);
    expect(runtimePlan.volumes.some(
      (volume) => volume.container === '/home/dev/.config/herdr',
    )).toBe(false);
  });

  // .local/bin is shared by Claude Code and herdr; two --volume entries for
  // the same container path would also double-count against the mount limit.
  test('Claude Code mounts its install dirs, deduped against the herdr bin mount', () => {
    const runtimePlan = planFor({
      attach: 'herdr',
      tools: [{ name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' }],
    });

    const stateRoot = path.join(tmpDir, 'pi-tin', 'workspace-state', 'demo');
    expect(runtimePlan.managedStateMountPaths).toEqual([
      '.local/share/claude',
      '.local/bin',
      '.config/herdr',
    ]);
    expect(runtimePlan.volumes.filter((volume) => volume.container === '/home/dev/.local/bin'))
      .toEqual([{ host: path.join(stateRoot, '.local', 'bin'), container: '/home/dev/.local/bin' }]);
  });

  test('an existing host.mounts entry at a managed path overrides the managed mount', () => {
    const userDir = path.join(tmpDir, 'my-herdr');
    fs.mkdirSync(userDir, { recursive: true });
    const runtimePlan = planFor({
      attach: 'herdr',
      host: { mounts: [{ host: userDir, container: '/home/dev/.config/herdr', readonly: false }] },
    });

    const herdrVolumes = runtimePlan.volumes.filter(
      (volume) => volume.container === '/home/dev/.config/herdr',
    );
    expect(herdrVolumes).toEqual([
      { host: userDir, container: '/home/dev/.config/herdr', readonly: false },
    ]);
    expect(runtimePlan.managedStateMountPaths).toEqual(['.local/bin']);
    expect(runtimePlan.notices).toContainEqual({
      kind: 'info',
      text: '~/.config/herdr uses the existing mount at /home/dev/.config/herdr instead of the managed workspace-state mount.',
    });
  });
});

// Copy-in is the destructive direction: each entry starts with a root
// `rm -rf` of the container path, so a workspace_state path sitting on any of
// the container's live mounts deletes the host side of it through virtiofs.
// The mount set it filters against is the plan the container starts from, so
// every mount the plan resolves — not just pi-tin's own managed ones — is
// covered.
describe('statePathsForCopyIn', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  // The issue's scenario: the host's own ~/.cache/uv mounted at the container
  // path a custom profile also declares as workspace_state.
  const runFilter = (workspaceStatePaths: string[]): { paths: string[]; warnings: string[] } => {
    const hostCacheDir = path.join(tmpDir, 'uv-cache');
    fs.mkdirSync(hostCacheDir, { recursive: true });
    const workspace = validateWorkspace({
      profile: 'node-dev',
      projects: [],
      host: { mounts: [{ host: hostCacheDir, container: '/home/dev/.cache/uv', readonly: false }] },
    });
    const containerProfile = validateContainerProfile({
      description: 'fixture',
      base_image: 'node:22',
      user: 'dev',
      workspace_state: workspaceStatePaths,
    });
    const context = {
      wsName: 'demo',
      containerName: containerNameFor('demo'),
      imageTag: imageTagFor('demo'),
      workspace,
      containerProfile,
      resources: resolveResources(containerProfile),
    };

    const warnings: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      return {
        paths: statePathsForCopyIn(context, computeRuntimeStartPlan(context)),
        warnings,
      };
    } finally {
      warn.mockRestore();
    }
  };

  test('drops a path mounted by host.mounts, warning about the mount it overlaps', () => {
    const { paths, warnings } = runFilter(['.cache/uv', '.zsh_history']);

    expect(paths).toEqual(['.zsh_history']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "Warning: workspace_state path '.cache/uv' overlaps the live mount at /home/dev/.cache/uv — skipping the snapshot; that path already persists via the mount.",
    );
  });

  test('paths clear of every mount the plan resolves still sync', () => {
    const { paths, warnings } = runFilter(['.local/share/zoxide', '.zsh_history']);

    expect(paths).toEqual(['.local/share/zoxide', '.zsh_history']);
    expect(warnings).toEqual([]);
  });
});

// Shared by the statePathsForCopyOut and snapshotThenRemoveContainer suites —
// both drive the same copy-out filter against recorded runtime meta, and a
// drifted copy of either fixture would leave the two suites silently testing
// different containers.
const writeCopyOutMetaFixture = (tmpDir: string, mountedContainerPaths: string[] | undefined): void => {
  const runtimeDir = path.join(tmpDir, 'pi-tin', 'state', 'runtime', 'demo');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'meta.json'), JSON.stringify({
    startedAt: '2026-07-29T10:00:00.000Z',
    buildHash: 'build',
    runtimeHash: 'runtime',
    ...(mountedContainerPaths === undefined ? {} : { mountedContainerPaths }),
  }));
};

// No Claude Code in tools and attach: shell — the current config derives no
// managed mounts at all, so only the container's own record can save these
// paths from the copy-out.
const copyOutContextFor = (): Parameters<typeof statePathsForCopyOut>[0] => {
  const workspace = validateWorkspace({ profile: 'node-dev', projects: [] });
  const containerProfile = validateContainerProfile({
    description: 'fixture',
    base_image: 'node:22',
    user: 'dev',
    workspace_state: ['.local/share/claude', '.zsh_history'],
  });
  return {
    wsName: 'demo',
    containerName: containerNameFor('demo'),
    imageTag: imageTagFor('demo'),
    workspace,
    containerProfile,
    resources: resolveResources(containerProfile),
  };
};

// Copy-out is the half that can destroy a live mount from the host side (its
// promote step is an rm + rename over the mount's host dir), and it runs
// against a container this session may only have joined — so which paths it
// may touch is decided from that container's own mount record.
describe('statePathsForCopyOut', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  const captureWarnings = <T>(fn: () => T): { result: T; warnings: string[] } => {
    const warnings: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      return { result: fn(), warnings };
    } finally {
      warn.mockRestore();
    }
  };

  test('drops a path the running container still has mounted, whatever config now says', () => {
    writeCopyOutMetaFixture(tmpDir, ['/home/dev/.local/share/claude', '/home/dev/.local/bin']);

    const { result, warnings } = captureWarnings(() => statePathsForCopyOut(copyOutContextFor(), true, 'session-close'));

    expect(result).toEqual(['.zsh_history']);
    expect(warnings).toEqual([]);
  });

  test('a container matching its config still syncs every unmounted path', () => {
    writeCopyOutMetaFixture(tmpDir, undefined);

    const { result, warnings } = captureWarnings(() => statePathsForCopyOut(copyOutContextFor(), false, 'session-close'));

    expect(result).toEqual(['.local/share/claude', '.zsh_history']);
    expect(warnings).toEqual([]);
  });

  // A container from a pi-tin that recorded no mounts, joined after a config
  // change: the config-derived fallback would clear .local/share/claude to
  // sync even though the container may well still mount it.
  test('skips the snapshot when config has changed and the container recorded no mounts', () => {
    writeCopyOutMetaFixture(tmpDir, undefined);

    const { result, warnings } = captureWarnings(() => statePathsForCopyOut(copyOutContextFor(), true, 'session-close'));

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "Warning: skipping the workspace_state snapshot for 'demo' — its container predates pi-tin's record of which paths it mounts, and the config has changed since it started. Restart the workspace to resume snapshots.",
    );
  });
});

// The restart deletes the container the snapshot reads from, so the ordering
// is the whole bug surface (issue #34 was this copy-out missing entirely):
// injected effects pin sync-before-stop the way the auto-stop tests pin
// theirs. Reverting the wiring — dropping the sync, or stopping first —
// fails here.
describe('snapshotThenRemoveContainer', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  type RestartSyncOptions = Parameters<RestartTeardownDeps['syncWorkspaceState']>[0];

  const createTeardownHarness = (): {
    calls: string[];
    syncOptions: RestartSyncOptions[];
    deps: RestartTeardownDeps;
  } => {
    const calls: string[] = [];
    const syncOptions: RestartSyncOptions[] = [];
    return {
      calls,
      syncOptions,
      deps: {
        syncWorkspaceState: async (options) => {
          calls.push('sync-copy-out');
          syncOptions.push(options);
        },
        stopAndRemoveContainer: async () => {
          calls.push('stop-and-remove');
        },
      },
    };
  };

  test('snapshots workspace state out, mount-filtered, before the container is removed', async () => {
    writeCopyOutMetaFixture(tmpDir, ['/home/dev/.local/share/claude']);
    const harness = createTeardownHarness();

    await snapshotThenRemoveContainer(copyOutContextFor(), true, harness.deps);

    expect(harness.calls).toEqual(['sync-copy-out', 'stop-and-remove']);
    expect(harness.syncOptions).toEqual([{
      containerName: containerNameFor('demo'),
      workspaceName: 'demo',
      paths: ['.zsh_history'],
      user: 'dev',
      direction: 'copy-out',
    }]);
  });

  // The drift flag is what protects a pre-record container: passing false
  // here would fall back to config-derived mounts that no longer describe
  // the drifted container, and sync both paths.
  test('a drifted container with no mount record skips the snapshot but is still removed', async () => {
    writeCopyOutMetaFixture(tmpDir, undefined);
    const harness = createTeardownHarness();
    const warnings: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    try {
      await snapshotThenRemoveContainer(copyOutContextFor(), true, harness.deps);
    } finally {
      warn.mockRestore();
    }

    expect(harness.calls).toEqual(['sync-copy-out', 'stop-and-remove']);
    expect(harness.syncOptions).toEqual([{
      containerName: containerNameFor('demo'),
      workspaceName: 'demo',
      paths: [],
      user: 'dev',
      direction: 'copy-out',
    }]);
    // Hand-written literal, not the session-close variant: the close-out's
    // "Restart the workspace to resume snapshots" advice is stale here — the
    // restart it asks for is the command already running.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "Warning: skipping the workspace_state snapshot for 'demo' — its container predates pi-tin's record of which paths it mounts, and the config has changed since it started. Snapshots resume from this restart.",
    );
  });
});

// The runtime hash is the sole drift signal: a running workspace only restarts
// when it moves. A dimension silently dropped from the hash disables the
// restart for that dimension with no other symptom, so each one gets its own
// "a change moves the hash" pin.
describe('computeRuntimeStartPlan runtime hash drift', () => {
  let tmpDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  const planFor = (
    workspaceExtra: Record<string, unknown> = {},
    containerProfileExtra: Record<string, unknown> = {},
  ): ReturnType<typeof computeRuntimeStartPlan> => {
    const workspace = validateWorkspace({
      profile: 'node-dev',
      projects: [projectDir],
      ...workspaceExtra,
    });
    const containerProfile = validateContainerProfile({
      description: 'fixture',
      base_image: 'node:22',
      user: 'dev',
      ...containerProfileExtra,
    });
    return computeRuntimeStartPlan({
      wsName: 'demo',
      containerName: containerNameFor('demo'),
      imageTag: imageTagFor('demo'),
      workspace,
      containerProfile,
      resources: resolveResources(containerProfile),
    });
  };

  test('an unchanged workspace hashes identically across calls', () => {
    expect(planFor().runtimeHash).toBe(planFor().runtimeHash);
  });

  test('a new project mount moves the hash', () => {
    const second = path.join(tmpDir, 'other-proj');
    fs.mkdirSync(second, { recursive: true });

    const before = planFor();
    const after = planFor({ projects: [projectDir, second] });

    expect(after.volumes.length).toBe(before.volumes.length + 1);
    expect(after.runtimeHash).not.toBe(before.runtimeHash);
  });

  test('mount ordering alone does not move the hash', () => {
    const second = path.join(tmpDir, 'other-proj');
    fs.mkdirSync(second, { recursive: true });

    expect(planFor({ projects: [projectDir, second] }).runtimeHash)
      .toBe(planFor({ projects: [second, projectDir] }).runtimeHash);
  });

  test('a readonly flip on the same mount moves the hash', () => {
    const shared = path.join(tmpDir, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    const mount = (readonly: boolean): Record<string, unknown> => ({
      host: { mounts: [{ host: shared, container: '/mnt/shared', readonly }] },
    });

    expect(planFor(mount(true)).runtimeHash).not.toBe(planFor(mount(false)).runtimeHash);
  });

  test('changed cpu and memory resources move the hash', () => {
    const base = planFor({}, { cpus: 4, memory: '8g' });

    expect(planFor({}, { cpus: 8, memory: '8g' }).runtimeHash).not.toBe(base.runtimeHash);
    expect(planFor({}, { cpus: 4, memory: '16g' }).runtimeHash).not.toBe(base.runtimeHash);
  });

  test('host.sshAgent moves the hash', () => {
    const withAgent = planFor({ host: { sshAgent: true } });
    const withoutAgent = planFor({ host: { sshAgent: false } });

    expect(withAgent.ssh).toBe(true);
    expect(withoutAgent.ssh).toBe(false);
    expect(withoutAgent.runtimeHash).not.toBe(withAgent.runtimeHash);
  });

  // githubCLI also adds a ~/.config/gh mount when that directory exists on the
  // host, so a bare toggle would move the hash through `volumes` on some
  // machines and prove nothing about the field. Pairing the toggle against an
  // explicit host.mount of the same directory keeps `volumes` identical either
  // way (asserted below), leaving githubCLI as the only hashed difference.
  test('host.githubCLI moves the hash independently of the gh mount it adds', () => {
    const withFlag = planFor({ host: { githubCLI: true } });
    const withMountOnly = planFor({
      host: {
        githubCLI: false,
        mounts: [{
          host: getHostGhConfigDir(),
          container: `${containerHomeDir('dev')}/.config/gh`,
          readonly: true,
        }],
      },
    });

    expect(withMountOnly.volumes).toEqual(withFlag.volumes);
    expect(withFlag.runtimeHash).not.toBe(withMountOnly.runtimeHash);
  });

  test('host.env keys and values both move the hash', () => {
    const none = planFor({ host: { env: {} } });
    const oneKey = planFor({ host: { env: { FOO: 'a' } } });
    const changedValue = planFor({ host: { env: { FOO: 'b' } } });
    const extraKey = planFor({ host: { env: { FOO: 'a', BAR: 'a' } } });

    expect(oneKey.runtimeHash).not.toBe(none.runtimeHash);
    expect(changedValue.runtimeHash).not.toBe(oneKey.runtimeHash);
    expect(extraKey.runtimeHash).not.toBe(oneKey.runtimeHash);
  });

  test('host.env key ordering alone does not move the hash', () => {
    expect(planFor({ host: { env: { AAA: '1', ZZZ: '2' } } }).runtimeHash)
      .toBe(planFor({ host: { env: { ZZZ: '2', AAA: '1' } } }).runtimeHash);
  });
});

describe('planAttachPreflight', () => {
  const base = {
    workspaceName: 'demo',
    configuredAttach: 'shell' as const,
    attachOverride: undefined,
    sshdEnabled: false,
    herdrPresent: false,
  };

  test('defaults to shell', () => {
    expect(planAttachPreflight(base)).toEqual({ mode: 'shell' });
  });

  test('override to shell wins over a herdr workspace', () => {
    expect(planAttachPreflight({
      ...base,
      configuredAttach: 'herdr',
      attachOverride: 'shell',
    })).toEqual({ mode: 'shell' });
  });

  test('herdr without sshd refuses with the config remediation', () => {
    const plan = planAttachPreflight({ ...base, attachOverride: 'herdr' });
    expect(plan.mode).toBe('refuse');
    if (plan.mode === 'refuse') {
      expect(plan.message).toContain('sshd');
      expect(plan.message).toContain("'attach: herdr' or 'sshd: true'");
    }
  });

  test('herdr without the local binary refuses with the install hint', () => {
    const plan = planAttachPreflight({
      ...base,
      configuredAttach: 'herdr',
      sshdEnabled: true,
      herdrPresent: false,
    });
    expect(plan.mode).toBe('refuse');
    if (plan.mode === 'refuse') {
      expect(plan.message).toContain('herdr is not installed');
    }
  });

  test('herdr proceeds when sshd and the binary are present', () => {
    expect(planAttachPreflight({
      ...base,
      configuredAttach: 'herdr',
      sshdEnabled: true,
      herdrPresent: true,
    })).toEqual({ mode: 'herdr' });
  });
});

describe('planHerdrAttach', () => {
  test('refuses without a container IP', () => {
    const plan = planHerdrAttach({ workspaceName: 'demo', ipv4Address: null });
    expect(plan.mode).toBe('refuse');
    if (plan.mode === 'refuse') {
      expect(plan.message).toContain('no IP address');
    }
  });

  test('resolves the host alias from the container name', () => {
    expect(planHerdrAttach({ workspaceName: 'demo', ipv4Address: '192.168.64.5' })).toEqual({
      mode: 'herdr',
      hostAlias: 'pi-tin-demo',
      ipv4Address: '192.168.64.5',
    });
  });
});

describe('planAutoStopDecision', () => {
  const base = {
    containerState: 'running' as const,
    runtimeState: 'ok' as const,
    activeSessions: 0,
    deadlineMatches: true,
    agentStates: { kind: 'not-applicable' as const },
  };

  test('stops an idle workspace', () => {
    expect(planAutoStopDecision(base)).toEqual({ action: 'stop' });
  });

  test('bails on non-running or unknown container state', () => {
    expect(planAutoStopDecision({ ...base, containerState: 'stopped' })).toEqual({ action: 'bail' });
    expect(planAutoStopDecision({ ...base, containerState: 'unknown' })).toEqual({ action: 'bail' });
  });

  test('bails on inconsistent runtime, live sessions, or a superseded deadline', () => {
    expect(planAutoStopDecision({ ...base, runtimeState: 'corrupt' })).toEqual({ action: 'bail' });
    expect(planAutoStopDecision({ ...base, activeSessions: 2 })).toEqual({ action: 'bail' });
    expect(planAutoStopDecision({ ...base, deadlineMatches: false })).toEqual({ action: 'bail' });
  });

  test('defers while any herdr agent is working', () => {
    expect(planAutoStopDecision({
      ...base,
      agentStates: { kind: 'states', working: 1 },
    })).toEqual({ action: 'defer' });
  });

  test('stops when agents are all idle or the query is unavailable', () => {
    expect(planAutoStopDecision({
      ...base,
      agentStates: { kind: 'states', working: 0 },
    })).toEqual({ action: 'stop' });
    expect(planAutoStopDecision({
      ...base,
      agentStates: { kind: 'unavailable' },
    })).toEqual({ action: 'stop' });
  });
});

describe('planWorkspaceOpen', () => {
  test('starts fresh when the container is missing and stale runtime state exists', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'not-found',
      runtimeState: 'corrupt',
      hasRuntimeMeta: false,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'start',
      activeSessionsAfterOpen: 1,
      clearStaleRuntimeState: true,
      deleteStoppedContainer: false,
    });
  });

  test('starts fresh and deletes a stopped container record first', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'stopped',
      runtimeState: 'missing',
      hasRuntimeMeta: false,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'start',
      activeSessionsAfterOpen: 1,
      clearStaleRuntimeState: false,
      deleteStoppedContainer: true,
    });
  });

  test('refuses when the container state is unknown', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'unknown',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 1,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'refuse',
      message: [
        "Could not determine the state of workspace 'demo' — listing containers failed.",
        "Check the container system is running ('container system start'), then retry.",
      ].join('\n'),
    });
  });

  test('refuses when the container is running but runtime state is unreadable', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'corrupt',
      hasRuntimeMeta: false,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'refuse',
      message: [
        "Workspace 'demo' is running, but its runtime state could not be read.",
        'pi-tin cannot safely join or restart it in this state.',
        'To reset it: pi-tin stop demo',
        'If needed: pi-tin stop demo --force',
      ].join('\n'),
    });
  });

  // The refuse branch has two independent triggers. Without this case the
  // hasRuntimeMeta check could be deleted outright and every test would still
  // pass, because 'corrupt' already satisfies the runtimeState half.
  test('refuses when runtime state reads ok but the runtime metadata is gone', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: false,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'refuse',
      message: [
        "Workspace 'demo' is running, but its runtime state could not be read.",
        'pi-tin cannot safely join or restart it in this state.',
        'To reset it: pi-tin stop demo',
        'If needed: pi-tin stop demo --force',
      ].join('\n'),
    });
  });

  test('refuses --build while active sessions exist', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 2,
      buildRequested: true,
      hasDrift: false,
    })).toEqual({
      action: 'refuse',
      message: "Workspace 'demo' already has 2 active sessions.\nStop it first with 'pi-tin stop demo'.",
    });
  });

  test('joins an active workspace and warns when changes are deferred to restart', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 2,
      buildRequested: false,
      hasDrift: true,
    })).toEqual({
      action: 'join',
      activeSessionsAfterOpen: 3,
      deferredRestartMessage: "Warning: workspace changes will apply on the next restart of 'demo'.",
    });
  });

  test('defers to the agent check during grace when config drift is detected', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: true,
    })).toEqual({ action: 'restart-if-idle' });
  });

  // The other half of the restart condition: --build during the grace window
  // restarts even with no drift. Without this, dropping buildRequested from
  // the restart check would silently turn --build into a plain rejoin.
  test('defers to the agent check during grace when --build is requested without drift', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 0,
      buildRequested: true,
      hasDrift: false,
    })).toEqual({ action: 'restart-if-idle' });
  });

  test('joins during grace when no restart is needed', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: false,
    })).toEqual({
      action: 'join',
      activeSessionsAfterOpen: 1,
      deferredRestartMessage: null,
    });
  });
});

describe('planRestartIfIdle', () => {
  test('joins and explains itself while agents are working', () => {
    expect(planRestartIfIdle({
      workspaceName: 'demo',
      agentStates: { kind: 'states', working: 2 },
      hasDrift: true,
    })).toEqual({
      action: 'join',
      activeSessionsAfterOpen: 1,
      deferredRestartMessage: [
        "Warning: 'demo' has 2 working agents — joining the running workspace instead of restarting it.",
        'Config changes apply on the next restart.',
      ].join('\n'),
    });
  });

  // --build without drift also lands here, and there are no config changes to
  // promise on a later restart — saying so anyway would be a lie.
  test('omits the config-changes line when the restart was not drift-driven', () => {
    expect(planRestartIfIdle({
      workspaceName: 'demo',
      agentStates: { kind: 'states', working: 1 },
      hasDrift: false,
    })).toEqual({
      action: 'join',
      activeSessionsAfterOpen: 1,
      deferredRestartMessage:
        "Warning: 'demo' has 1 working agent — joining the running workspace instead of restarting it.",
    });
  });

  test('restarts when every agent is idle', () => {
    expect(planRestartIfIdle({
      workspaceName: 'demo',
      agentStates: { kind: 'states', working: 0 },
      hasDrift: true,
    })).toEqual({ action: 'restart', activeSessionsAfterOpen: 1 });
  });

  // Matches planAutoStopDecision: a query that can never succeed must not
  // leave a workspace permanently unrebuildable.
  test('restarts when the agent query is unavailable', () => {
    expect(planRestartIfIdle({
      workspaceName: 'demo',
      agentStates: { kind: 'unavailable' },
      hasDrift: true,
    })).toEqual({ action: 'restart', activeSessionsAfterOpen: 1 });
  });

  test('restarts on a non-herdr workspace', () => {
    expect(planRestartIfIdle({
      workspaceName: 'demo',
      agentStates: { kind: 'not-applicable' },
      hasDrift: true,
    })).toEqual({ action: 'restart', activeSessionsAfterOpen: 1 });
  });
});

// The layer the original bug lived in: both planners were fine in isolation,
// nothing wired the question into the open path.
describe('resolveOpenPlan', () => {
  const unexpectedQuery = (): HerdrAgentStates => {
    throw new Error('unexpected agent query');
  };

  test('queries the container and resolves a restart-if-idle plan', () => {
    expect(resolveOpenPlan({ action: 'restart-if-idle' }, {
      workspaceName: 'demo',
      hasDrift: true,
      queryAgentStates: () => ({ kind: 'states', working: 3 }),
    })).toEqual({
      action: 'join',
      activeSessionsAfterOpen: 1,
      deferredRestartMessage: [
        "Warning: 'demo' has 3 working agents — joining the running workspace instead of restarting it.",
        'Config changes apply on the next restart.',
      ].join('\n'),
    });
  });

  test('passes every other action through without querying', () => {
    const plans = [
      { action: 'start' as const, activeSessionsAfterOpen: 1 as const, clearStaleRuntimeState: false, deleteStoppedContainer: false },
      { action: 'join' as const, activeSessionsAfterOpen: 2, deferredRestartMessage: null },
      { action: 'restart' as const, activeSessionsAfterOpen: 1 as const },
      { action: 'refuse' as const, message: 'nope' },
    ];

    for (const plan of plans) {
      expect(resolveOpenPlan(plan, {
        workspaceName: 'demo',
        hasDrift: true,
        queryAgentStates: unexpectedQuery,
      })).toEqual(plan);
    }
  });
});

describe('planImageBuild', () => {
  const base = {
    forceBuild: false,
    driftDetected: false,
    previousBuildHash: 'abc',
    newBuildHash: 'abc',
    imagePresent: true,
  };

  test('does not build when nothing changed and the image exists', () => {
    expect(planImageBuild(base)).toEqual({ build: false, announceConfigChange: false });
  });

  test('builds without announcing when the image is missing (first build)', () => {
    expect(planImageBuild({ ...base, imagePresent: false })).toEqual({
      build: true,
      announceConfigChange: false,
    });
  });

  // Regression: a drift-triggered restart rebuilds the existing image, so the
  // user must be told why. Previously drift was folded into forceBuild, which
  // silenced this message.
  test('announces the config change when drift rebuilds an existing image', () => {
    expect(planImageBuild({ ...base, driftDetected: true })).toEqual({
      build: true,
      announceConfigChange: true,
    });
  });

  test('announces when the recorded build hash differs from the new one', () => {
    expect(planImageBuild({ ...base, newBuildHash: 'def' })).toEqual({
      build: true,
      announceConfigChange: true,
    });
  });

  test('does not announce a bare --build with no config change', () => {
    expect(planImageBuild({ ...base, forceBuild: true })).toEqual({
      build: true,
      announceConfigChange: false,
    });
  });

  test('treats a never-built image (null previous hash) as not a config change', () => {
    expect(planImageBuild({ ...base, previousBuildHash: null, imagePresent: false })).toEqual({
      build: true,
      announceConfigChange: false,
    });
  });
});

describe('planBuildFailureFallback', () => {
  test('offers the previous image when one exists and a human is attached', () => {
    expect(planBuildFailureFallback({ imagePresent: true, isInteractive: true }))
      .toEqual({ action: 'offer' });
  });

  test('aborts when there is no previous image to fall back to', () => {
    expect(planBuildFailureFallback({ imagePresent: false, isInteractive: true }))
      .toEqual({ action: 'abort', reason: 'no-image' });
  });

  test('aborts non-interactively rather than hang on a prompt no one can answer', () => {
    expect(planBuildFailureFallback({ imagePresent: true, isInteractive: false }))
      .toEqual({ action: 'abort', reason: 'non-interactive' });
  });

  test('a missing image aborts even when non-interactive (no-image takes precedence)', () => {
    expect(planBuildFailureFallback({ imagePresent: false, isInteractive: false }))
      .toEqual({ action: 'abort', reason: 'no-image' });
  });
});

describe('planAddProject', () => {
  const base = {
    projectPath: '/Users/dave/Dev/new-app',
    workspaceName: 'work',
    existingProjects: ['/Users/dave/Dev/my-app'],
    projectedSharedDirectoryCount: 5,
    maxSharedDirectories: 22,
    containerState: 'stopped' as const,
    isInteractive: true,
  };

  // Hand-written rather than imported from workspace-plans — asserting the
  // module's own constant against itself would pass after any wording change.
  // Shared by the interactive and headless running-workspace tests, which
  // must produce the same message.
  const expectedRunningMessage = [
    "Added new-app to workspace 'work'.",
    "'work' is running, so the project isn't mounted yet — that happens on its next restart.",
    "Once you've finished and exited every open session in 'work', the next 'pi-tin open work' will restart it and mount the project.",
    '(Reopening while a session is still active — or while herdr agents are still working — just rejoins it unchanged.)',
  ].join('\n');

  test('adds and opens when the workspace is not running', () => {
    expect(planAddProject(base)).toEqual({ action: 'add-and-open' });
  });

  test('adds and messages (no open) when headless and the workspace is not running', () => {
    expect(planAddProject({ ...base, isInteractive: false })).toEqual({
      action: 'add-and-message',
      message: [
        "Added new-app to workspace 'work'.",
        "Run 'pi-tin open work' from a terminal to start it with the project mounted.",
      ].join('\n'),
    });
  });

  test('headless add to a running workspace keeps the restart message', () => {
    expect(planAddProject({ ...base, containerState: 'running', isInteractive: false })).toEqual({
      action: 'add-and-message',
      message: expectedRunningMessage,
    });
  });

  test('adds and messages (no open) when the workspace is running', () => {
    expect(planAddProject({ ...base, containerState: 'running' })).toEqual({
      action: 'add-and-message',
      message: expectedRunningMessage,
    });
  });

  test('rejects when the container state is unknown', () => {
    expect(planAddProject({ ...base, containerState: 'unknown' })).toEqual({
      action: 'reject',
      message: [
        "Could not determine the state of workspace 'work' — listing containers failed.",
        "Check the container system is running ('container system start'), then retry.",
      ].join('\n'),
    });
  });

  test('rejects when the project is already present', () => {
    expect(planAddProject({ ...base, existingProjects: ['/Users/dave/Dev/new-app'] })).toEqual({
      action: 'reject',
      message: "Project is already in workspace 'work': /Users/dave/Dev/new-app",
    });
  });

  test('rejects on basename collision', () => {
    expect(planAddProject({
      ...base,
      projectPath: '/Users/dave/other/my-app',
      existingProjects: ['/Users/dave/Dev/my-app'],
    })).toEqual({
      action: 'reject',
      message: [
        "Project basename collision 'my-app' between:",
        '  /Users/dave/other/my-app',
        '  /Users/dave/Dev/my-app',
      ].join('\n'),
    });
  });

  test('rejects when projected mounts exceed the limit', () => {
    expect(planAddProject({ ...base, projectedSharedDirectoryCount: 23 })).toEqual({
      action: 'reject',
      message: [
        "Workspace 'work' requires 23 shared host directories, but pi-tin currently supports up to 22 per workspace start.",
        'This conservative limit avoids Apple container startup failures with large mount sets.',
        'Projects, host mounts, agent profiles, agent install mounts, tmux mounts, the herdr state mount, and GitHub CLI mounts all count.',
        'Each project counts separately.',
        'Reduce mounted directories or split the workspace.',
      ].join('\n'),
    });
  });
});

describe('loginShellCommand', () => {
  test('resolves the user login shell and falls back to /bin/sh', () => {
    const command = loginShellCommand('dev');
    expect(command[0]).toBe('/bin/sh');
    expect(command[1]).toBe('-c');
    expect(command[2]).toContain('grep "^dev:" /etc/passwd');
    expect(command[2]).toContain('[ -x "$s" ] || s=/bin/sh');
    expect(command[2]).toContain('exec "$s"');
  });

  test('interpolates the given username into the passwd lookup', () => {
    expect(loginShellCommand('coder')[2]).toContain('grep "^coder:" /etc/passwd');
  });
});
