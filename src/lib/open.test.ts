import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planWorkspaceOpen, planAddProject, planImageBuild } from './workspace-plans.js';
import { openWorkspace, countSharedDirectories, computeRuntimeStartPlan } from './open.js';
import { validateConfig, validateContainerProfile, validateWorkspace } from './validators.js';
import { resolveResources } from './resources.js';
import { containerNameFor, imageTagFor } from './container.js';
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
        config: validateConfig({ shell: 'zsh' }),
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
      warnAboutDeferredRestart: true,
    });
  });

  test('restarts during grace when drift or build is requested', () => {
    expect(planWorkspaceOpen({
      workspaceName: 'demo',
      containerState: 'running',
      runtimeState: 'ok',
      hasRuntimeMeta: true,
      activeSessions: 0,
      buildRequested: false,
      hasDrift: true,
    })).toEqual({
      action: 'restart',
      activeSessionsAfterOpen: 1,
    });
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
      warnAboutDeferredRestart: false,
    });
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

describe('planAddProject', () => {
  const base = {
    projectPath: '/Users/dave/Dev/new-app',
    workspaceName: 'work',
    existingProjects: ['/Users/dave/Dev/my-app'],
    projectedSharedDirectoryCount: 5,
    maxSharedDirectories: 22,
    containerState: 'stopped' as const,
  };

  test('adds and opens when the workspace is not running', () => {
    expect(planAddProject(base)).toEqual({ action: 'add-and-open' });
  });

  test('adds and messages (no open) when the workspace is running', () => {
    const plan = planAddProject({ ...base, containerState: 'running' });
    expect(plan.action).toBe('add-and-message');
    if (plan.action !== 'add-and-message') throw new Error('wrong action');
    expect(plan.message).toContain('new-app');
    expect(plan.message).toContain("'work'");
    expect(plan.message).toContain('restart');
    expect(plan.message).not.toContain('pi-tin stop');
  });

  test('rejects when the container state is unknown', () => {
    const plan = planAddProject({ ...base, containerState: 'unknown' });
    expect(plan.action).toBe('reject');
    if (plan.action !== 'reject') throw new Error('wrong action');
    expect(plan.message).toContain('Could not determine');
    expect(plan.message).toContain("'work'");
  });

  test('rejects when the project is already present', () => {
    const plan = planAddProject({ ...base, existingProjects: ['/Users/dave/Dev/new-app'] });
    expect(plan.action).toBe('reject');
    if (plan.action !== 'reject') throw new Error('wrong action');
    expect(plan.message).toContain('already');
  });

  test('rejects on basename collision', () => {
    const plan = planAddProject({
      ...base,
      projectPath: '/Users/dave/other/my-app',
      existingProjects: ['/Users/dave/Dev/my-app'],
    });
    expect(plan.action).toBe('reject');
    if (plan.action !== 'reject') throw new Error('wrong action');
    expect(plan.message).toContain("basename collision 'my-app'");
  });

  test('rejects when projected mounts exceed the limit', () => {
    const plan = planAddProject({ ...base, projectedSharedDirectoryCount: 23 });
    expect(plan.action).toBe('reject');
    if (plan.action !== 'reject') throw new Error('wrong action');
    expect(plan.message).toContain('up to 22');
  });
});
