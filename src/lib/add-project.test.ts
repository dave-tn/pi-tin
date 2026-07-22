import { describe, test, expect } from 'bun:test';
import { addableWorkspaces, handleWorkspaceSelection, type WorkspaceMatch, type WorkspaceSelectionDeps } from './add-project.js';
import type { Workspace } from './validators.js';

function ws(projects: string[]): Workspace {
  return { profile: 'node-dev', projects, tools: [], sshd: false, attach: 'shell', stopAfterLastSession: '30s' };
}
function match(name: string, projects: string[]): WorkspaceMatch {
  return { name, workspace: ws(projects) };
}

describe('addableWorkspaces', () => {
  test('excludes workspaces already covering the directory', () => {
    const all = [match('work', ['/a']), match('scratch', ['/b'])];
    const covering = [match('work', ['/a'])];
    expect(addableWorkspaces(all, covering).map((m) => m.name)).toEqual(['scratch']);
  });
  test('returns all when none cover the directory', () => {
    const all = [match('work', ['/a']), match('scratch', ['/b'])];
    expect(addableWorkspaces(all, []).map((m) => m.name)).toEqual(['work', 'scratch']);
  });
  test('returns empty when every workspace covers the directory', () => {
    const all = [match('work', ['/a'])];
    expect(addableWorkspaces(all, [match('work', ['/a'])])).toEqual([]);
  });
});

describe('handleWorkspaceSelection', () => {
  function deps(overrides: Partial<WorkspaceSelectionDeps> = {}) {
    return {
      countSharedDirectories: () => 1,
      getContainerStateFor: () => 'stopped' as const,
      isInteractiveSession: () => true,
      appendProjectToWorkspace: () => {},
      computeContainerWorkdir: () => undefined,
      openWorkspace: () => {},
      log: () => {},
      error: () => {},
      exit: () => { throw new Error('exit'); },
      runCreateFlow: async () => {},
      ...overrides,
    };
  }
  test('create-new runs the create flow', async () => {
    let created = false;
    await handleWorkspaceSelection({ kind: 'create-new' }, '/x', deps({ runCreateFlow: async () => { created = true; } }));
    expect(created).toBe(true);
  });
  test('add-to appends and opens when stopped', async () => {
    let appended: [string, string] | undefined;
    let opened = false;
    await handleWorkspaceSelection(
      { kind: 'add-to', target: match('work', ['/a']) },
      '/x',
      deps({
        appendProjectToWorkspace: (n: string, p: string) => { appended = [n, p]; },
        openWorkspace: () => { opened = true; },
      }),
    );
    expect(appended).toEqual(['work', '/x']);
    expect(opened).toBe(true);
  });
  test('add-to appends without opening when the session is headless', async () => {
    let appended = false;
    let opened = false;
    const logs: string[] = [];
    await handleWorkspaceSelection(
      { kind: 'add-to', target: match('work', ['/a']) },
      '/x',
      deps({
        isInteractiveSession: () => false,
        appendProjectToWorkspace: () => { appended = true; },
        openWorkspace: () => { opened = true; },
        log: (...a: unknown[]) => logs.push(a.join(' ')),
      }),
    );
    expect(appended).toBe(true);
    expect(opened).toBe(false);
    expect(logs.join('\n')).toContain('pi-tin open work');
  });
  test('cancel prints hints and writes nothing', async () => {
    const logs: string[] = [];
    let appended = false;
    await handleWorkspaceSelection({ kind: 'cancel' }, '/x', deps({
      log: (...a: unknown[]) => logs.push(a.join(' ')),
      appendProjectToWorkspace: () => { appended = true; },
    }));
    expect(logs.join('\n')).toContain('pi-tin create');
    expect(appended).toBe(false);
  });
});
