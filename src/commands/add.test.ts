import { describe, test, expect } from 'bun:test';
import { runAddCommand, type AddCommandDeps } from './add.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import type { Workspace } from '../lib/validators.js';
import type { WorkspaceMatch } from '../lib/add-project.js';

function ws(projects: string[]): Workspace {
  return { profile: 'node-dev', projects, tools: [], sshd: false, attach: 'shell', stopAfterLastSession: '30s' };
}
function match(name: string, projects: string[]): WorkspaceMatch {
  return { name, workspace: ws(projects) };
}

function createDeps(overrides: Partial<AddCommandDeps> = {}): AddCommandDeps {
  return {
    ensureInitialised: () => {},
    ensureInteractive: () => {},
    cwd: () => '/Users/dave/Dev/new-app',
    withExitHandling: async (fn) => await fn(),
    findWorkspacesForDirectory: () => [],
    listWorkspaces: () => [],
    isValidWorkspaceName: () => true,
    select: async () => ({ kind: 'cancel' }),
    runCreateFlow: async () => {},
    computeContainerWorkdir: () => '/workspace/new-app',
    openWorkspace: () => {},
    countSharedDirectories: () => 2,
    getContainerStateFor: () => 'stopped',
    isInteractiveSession: () => true,
    appendProjectToWorkspace: () => {},
    log: () => {},
    error: () => {},
    exit: () => { throw new Error('exit'); },
    ...overrides,
  };
}

describe('runAddCommand — direct arg', () => {
  test('appends and opens when the named workspace is stopped and addable', async () => {
    let appended: [string, string] | undefined;
    let opened: { name: string; opts: { build?: boolean; workdir?: string | undefined } } | undefined;
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/Users/dave/Dev/my-app'])],
      findWorkspacesForDirectory: () => [],
      getContainerStateFor: () => 'stopped',
      appendProjectToWorkspace: (n, p) => { appended = [n, p]; },
      openWorkspace: (name, opts) => { opened = { name, opts }; },
    });
    await runAddCommand('work', deps);
    expect(appended).toEqual(['work', '/Users/dave/Dev/new-app']);
    expect(opened).toEqual({ name: 'work', opts: { build: false, workdir: '/workspace/new-app' } });
  });

  test('appends without opening when headless and the named workspace is stopped', async () => {
    let appended: [string, string] | undefined;
    let opened = false;
    const logs: string[] = [];
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/Users/dave/Dev/my-app'])],
      isInteractiveSession: () => false,
      appendProjectToWorkspace: (n, p) => { appended = [n, p]; },
      openWorkspace: () => { opened = true; },
      log: (...a: unknown[]) => logs.push(a.join(' ')),
    });
    await runAddCommand('work', deps);
    expect(appended).toEqual(['work', '/Users/dave/Dev/new-app']);
    expect(opened).toBe(false);
    expect(logs.join('\n')).toContain('pi-tin open work');
  });

  test('throws CliError(NOT_FOUND) when the named workspace does not exist', async () => {
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/a'])],
    });
    const err = await runAddCommand('ghost', deps).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.detail.badInput).toBe('ghost');
    expect(err.message).toContain('not found');
    expect(err.message).toContain('Available: work');
  });

  test('errors and exits when the named workspace name is invalid', async () => {
    let exitCode: number | undefined;
    let appended = false;
    const errs: string[] = [];
    const deps = createDeps({
      isValidWorkspaceName: () => false,
      appendProjectToWorkspace: () => { appended = true; },
      error: (...a: unknown[]) => errs.push(a.join(' ')),
      exit: (code) => { exitCode = code; throw new Error('exit'); },
    });
    await expect(runAddCommand('Bad Name', deps)).rejects.toThrow('exit');
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('Invalid');
    expect(errs.join('\n')).toContain('Bad Name');
    expect(appended).toBe(false);
  });

  test('throws CliError(NOT_FOUND) with "no workspaces configured" when none exist', async () => {
    let appended = false;
    const deps = createDeps({
      listWorkspaces: () => [],
      appendProjectToWorkspace: () => { appended = true; },
    });
    const err = await runAddCommand('ghost', deps).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.message).toContain('no workspaces configured');
    expect(appended).toBe(false);
  });

  test('refuses when the directory is already in the named workspace', async () => {
    let appended = false;
    let exitCode: number | undefined;
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/Users/dave/Dev/new-app'])],
      findWorkspacesForDirectory: () => [match('work', ['/Users/dave/Dev/new-app'])],
      appendProjectToWorkspace: () => { appended = true; },
      exit: (code) => { exitCode = code; throw new Error('exit'); },
    });
    await expect(runAddCommand('work', deps)).rejects.toThrow('exit');
    expect(appended).toBe(false);
    expect(exitCode).toBe(1);
  });
});

describe('runAddCommand — interactive', () => {
  test('no-arg add propagates the interactive_only refusal', async () => {
    const deps = createDeps({
      ensureInteractive: () => {
        throw new CliError('Cannot run non-interactively.', EXIT.GENERAL, { code: 'interactive_only' });
      },
      listWorkspaces: () => [match('work', ['/a'])],
    });
    const err = await runAddCommand(undefined, deps).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    if (!(err instanceof CliError)) throw new Error('unreachable');
    expect(err.detail.code).toBe('interactive_only');
  });

  test('runs the create flow when no workspaces exist', async () => {
    let created = false;
    const deps = createDeps({ listWorkspaces: () => [], runCreateFlow: async () => { created = true; } });
    await runAddCommand(undefined, deps);
    expect(created).toBe(true);
  });

  test('offers addable workspaces (excluding ones already containing the dir) and adds the pick', async () => {
    let offered: string[] = [];
    let appended: [string, string] | undefined;
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/Users/dave/Dev/new-app']), match('scratch', ['/Users/dave/Dev/lib'])],
      findWorkspacesForDirectory: () => [match('work', ['/Users/dave/Dev/new-app'])],
      select: async (opts) => {
        offered = opts.choices.map((c) => c.name);
        const scratch = opts.choices.find((c) => c.name === 'scratch');
        if (scratch === undefined) throw new Error('scratch not offered');
        return scratch.value;
      },
      appendProjectToWorkspace: (n, p) => { appended = [n, p]; },
    });
    await runAddCommand(undefined, deps);
    expect(offered).toEqual(['Create new workspace', 'scratch', 'Cancel']);
    expect(appended).toEqual(['scratch', '/Users/dave/Dev/new-app']);
  });

  test('offers only create/cancel when the dir is already in every workspace', async () => {
    let offered: string[] = [];
    const deps = createDeps({
      listWorkspaces: () => [match('work', ['/Users/dave/Dev/new-app'])],
      findWorkspacesForDirectory: () => [match('work', ['/Users/dave/Dev/new-app'])],
      select: async (opts) => {
        offered = opts.choices.map((c) => c.name);
        return { kind: 'cancel' };
      },
    });
    await runAddCommand(undefined, deps);
    expect(offered).toEqual(['Create new workspace', 'Cancel']);
  });
});
