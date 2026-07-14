import { describe, test, expect } from 'bun:test';
import { runDefaultAction, type DefaultActionDeps, type WorkspaceSelection } from './default-action.js';
import { CliError, EXIT } from './cli-errors.js';
import type { Workspace } from './validators.js';

function createWorkspace(projects: string[]): Workspace {
  return {
    profile: 'node-dev',
    projects,
    tools: [],
    stopAfterLastSession: '30s',
  };
}

async function passthroughWithExitHandling<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

function createDeps(overrides: Partial<DefaultActionDeps> = {}): DefaultActionDeps {
  return {
    ensureInitialised: () => {},
    ensureInteractive: () => {},
    cwd: () => '/Users/dave/Dev/my-app',
    findWorkspacesForDirectory: () => [],
    confirm: async () => true,
    select: async () => ({ kind: 'create-new' }),
    runCreateFlow: async () => {},
    computeContainerWorkdir: () => undefined,
    openWorkspace: () => {},
    withExitHandling: passthroughWithExitHandling,
    log: () => {},
    error: () => {},
    exit: () => {
      throw new Error('exit should not be called');
    },
    listWorkspaces: () => [],
    getContainerStateFor: () => 'stopped',
    isInteractiveSession: () => true,
    appendProjectToWorkspace: () => {},
    countSharedDirectories: () => 1,
    ...overrides,
  };
}

describe('runDefaultAction', () => {
  test('refuses non-interactive sessions before doing anything', async () => {
    let initialised = false;
    const deps = createDeps({
      ensureInteractive: () => {
        throw new CliError('Cannot choose non-interactively.', EXIT.GENERAL, { code: 'interactive_only' });
      },
      ensureInitialised: () => { initialised = true; },
    });
    const err = await runDefaultAction({}, deps).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.detail.code).toBe('interactive_only');
    expect(initialised).toBe(false);
  });

  test('forces a rebuild when auto-opening a single matching workspace', async () => {
    let opened:
      | { name: string; opts: { build?: boolean; workdir?: string | undefined } }
      | undefined;

    const deps = createDeps({
      cwd: () => '/Users/dave/Dev/my-app/src',
      findWorkspacesForDirectory: () => [
        {
          name: 'my-app',
          workspace: createWorkspace(['/Users/dave/Dev/my-app']),
        },
      ],
      computeContainerWorkdir: () => '/workspace/my-app/src',
      openWorkspace: (name, opts) => {
        opened = { name, opts };
      },
    });

    await runDefaultAction({ build: true }, deps);

    expect(opened).toEqual({
      name: 'my-app',
      opts: {
        build: true,
        workdir: '/workspace/my-app/src',
      },
    });
  });

  test('ignores --build when no workspace matches and runs create flow', async () => {
    let createCalls = 0;
    let openCalls = 0;
    let confirmMessage: string | undefined;

    const deps = createDeps({
      findWorkspacesForDirectory: () => [],
      confirm: async (options) => {
        confirmMessage = options.message;
        return true;
      },
      runCreateFlow: async () => {
        createCalls += 1;
      },
      openWorkspace: () => {
        openCalls += 1;
      },
    });

    await runDefaultAction({ build: true }, deps);

    expect(confirmMessage).toBe('No workspaces include this directory. Create one?');
    expect(createCalls).toBe(1);
    expect(openCalls).toBe(0);
  });

  test('forces a rebuild after selecting from multiple matching workspaces', async () => {
    let opened:
      | { name: string; opts: { build?: boolean; workdir?: string | undefined } }
      | undefined;
    let choices: Array<{ name: string; value: WorkspaceSelection }> | undefined;

    const deps = createDeps({
      cwd: () => '/Users/dave/Dev/my-app/src',
      findWorkspacesForDirectory: () => [
        {
          name: 'my-app',
          workspace: createWorkspace(['/Users/dave/Dev/my-app']),
        },
        {
          name: 'other-app',
          workspace: createWorkspace(['/Users/dave/Dev/my-app']),
        },
      ],
      select: async (options) => {
        choices = options.choices;
        const otherApp = options.choices.find((choice) => choice.name === 'other-app');
        if (!otherApp) {
          throw new Error('expected an other-app choice');
        }
        return otherApp.value;
      },
      computeContainerWorkdir: () => '/workspace/my-app/src',
      openWorkspace: (name, opts) => {
        opened = { name, opts };
      },
    });

    await runDefaultAction({ build: true }, deps);

    expect(choices?.map((choice) => choice.name)).toEqual([
      'my-app',
      'other-app',
      'Create new workspace',
    ]);
    expect(choices?.map((choice) => choice.value.kind)).toEqual(['open', 'open', 'create-new']);
    expect(opened).toEqual({
      name: 'other-app',
      opts: {
        build: true,
        workdir: '/workspace/my-app/src',
      },
    });
  });
});

describe('runDefaultAction — add to existing workspace', () => {
  test('keeps the create confirm when no workspaces exist', async () => {
    let created = false;
    const deps = createDeps({
      findWorkspacesForDirectory: () => [],
      listWorkspaces: () => [],
      confirm: async () => true,
      runCreateFlow: async () => { created = true; },
    });
    await runDefaultAction({}, deps);
    expect(created).toBe(true);
  });

  test('appends and opens when adding to a stopped workspace', async () => {
    let appended: { name: string; project: string } | undefined;
    let opened: { name: string; opts: { build?: boolean; workdir?: string | undefined } } | undefined;
    const deps = createDeps({
      cwd: () => '/Users/dave/Dev/new-app',
      findWorkspacesForDirectory: () => [],
      listWorkspaces: () => [{ name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) }],
      getContainerStateFor: () => 'stopped',
      countSharedDirectories: () => 2,
      computeContainerWorkdir: () => '/workspace/new-app',
      appendProjectToWorkspace: (name, project) => { appended = { name, project }; },
      openWorkspace: (name, opts) => { opened = { name, opts }; },
      select: async () => ({ kind: 'add-to', target: { name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) } }),
    });
    await runDefaultAction({}, deps);
    expect(appended).toEqual({ name: 'work', project: '/Users/dave/Dev/new-app' });
    expect(opened).toEqual({ name: 'work', opts: { build: false, workdir: '/workspace/new-app' } });
  });

  test('appends and prints message, does not open, when workspace is running', async () => {
    let appended = false;
    let openCalled = false;
    const logs: string[] = [];
    const deps = createDeps({
      cwd: () => '/Users/dave/Dev/new-app',
      findWorkspacesForDirectory: () => [],
      listWorkspaces: () => [{ name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) }],
      getContainerStateFor: () => 'running',
      countSharedDirectories: () => 2,
      appendProjectToWorkspace: () => { appended = true; },
      openWorkspace: () => { openCalled = true; },
      log: (...args: unknown[]) => { logs.push(args.join(' ')); },
      select: async () => ({ kind: 'add-to', target: { name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) } }),
    });
    await runDefaultAction({}, deps);
    expect(appended).toBe(true);
    expect(openCalled).toBe(false);
    expect(logs.join('\n')).toContain('restart');
  });

  test('rejects and exits without writing when the mount limit is exceeded', async () => {
    let appended = false;
    let exitCode: number | undefined;
    const deps = createDeps({
      cwd: () => '/Users/dave/Dev/new-app',
      findWorkspacesForDirectory: () => [],
      listWorkspaces: () => [{ name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) }],
      getContainerStateFor: () => 'stopped',
      countSharedDirectories: () => 23,
      appendProjectToWorkspace: () => { appended = true; },
      exit: (code: number) => { exitCode = code; throw new Error('exit'); },
      select: async () => ({ kind: 'add-to', target: { name: 'work', workspace: createWorkspace(['/Users/dave/Dev/my-app']) } }),
    });
    await expect(runDefaultAction({}, deps)).rejects.toThrow('exit');
    expect(appended).toBe(false);
    expect(exitCode).toBe(1);
  });
});
