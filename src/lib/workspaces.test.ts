import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import {
  appendProjectToWorkspace,
  deleteWorkspace,
  findWorkspacesForDirectory,
  listWorkspaces,
  loadWorkspace,
  workspaceExists,
  writeWorkspace,
} from './workspaces.js';

// Hand-written copy of the user-facing rule text in workspaces.ts. Deliberately
// not imported: an expectation derived from the module under test cannot detect
// the message changing, because both sides move together.
const WORKSPACE_NAME_RULE =
  "Names must be lowercase alphanumeric, and may contain '.', '-', or '_'. Must start with a letter or digit.";

function invalidNameMessage(name: string): string {
  return `Invalid workspace name '${name}'. ${WORKSPACE_NAME_RULE}`;
}

const NOT_FOUND_HINT = "Run 'pi-tin list' to see available workspaces.";

describe('findWorkspacesForDirectory', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    // Create the pi-tin subdirectory structure that getWorkspacesDir expects
    const piTinWsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(piTinWsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  function writeWorkspaceYaml(name: string, projects: string[]): void {
    const wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    const workspace = {
      profile: 'node-dev',
      projects,
    };
    fs.writeFileSync(path.join(wsDir, `${name}.yaml`), YAML.stringify(workspace));
  }

  test('returns empty array when no workspaces match', () => {
    writeWorkspaceYaml('ws1', ['/some/other/path']);
    const result = findWorkspacesForDirectory('/not/matching');
    expect(result).toEqual([]);
  });

  test('matches exact project path', () => {
    writeWorkspaceYaml('ws1', ['/Users/dev/my-app']);
    const result = findWorkspacesForDirectory('/Users/dev/my-app');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('ws1');
  });

  test('matches subdirectory of project path', () => {
    writeWorkspaceYaml('ws1', ['/Users/dev/my-app']);
    const result = findWorkspacesForDirectory('/Users/dev/my-app/src/components');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('ws1');
  });

  test('does not match partial directory name prefix', () => {
    writeWorkspaceYaml('ws1', ['/Users/dev/my-app']);
    const result = findWorkspacesForDirectory('/Users/dev/my-app-extra');
    expect(result).toEqual([]);
  });

  test('returns multiple matching workspaces', () => {
    writeWorkspaceYaml('ws1', ['/Users/dev/my-app']);
    writeWorkspaceYaml('ws2', ['/Users/dev/my-app', '/Users/dev/other']);
    const result = findWorkspacesForDirectory('/Users/dev/my-app');
    expect(result).toHaveLength(2);
    const names = result.map((entry) => entry.name).sort();
    expect(names).toEqual(['ws1', 'ws2']);
  });
});

describe('listWorkspaces', () => {
  let tmpDir: string;
  let wsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-list-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('returns an empty list when the workspaces directory has never been created', () => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    expect(listWorkspaces()).toEqual([]);
  });

  test('returns each .yaml workspace parsed, sorted by name, ignoring other files', () => {
    fs.writeFileSync(path.join(wsDir, 'zeta.yaml'), 'profile: node-dev\nprojects: [/z]\n');
    fs.writeFileSync(path.join(wsDir, 'alpha.yaml'), 'profile: python-dev\nprojects: [/a]\n');
    fs.writeFileSync(path.join(wsDir, 'notes.txt'), 'not a workspace\n');
    fs.writeFileSync(path.join(wsDir, 'alpha.yaml.bak'), 'profile: node-dev\nprojects: []\n');

    const result = listWorkspaces();

    expect(result.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    expect(result[0]?.workspace.profile).toBe('python-dev');
    expect(result[0]?.workspace.projects).toEqual(['/a']);
    expect(result[1]?.workspace.projects).toEqual(['/z']);
  });

  test('skips an unreadable workspace with a warning naming it and the reason, keeping the rest', () => {
    fs.writeFileSync(path.join(wsDir, 'good.yaml'), 'profile: node-dev\nprojects: []\n');
    fs.writeFileSync(path.join(wsDir, 'broken.yaml'), 'profile: node-dev\nprojects: not-an-array\n');

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = listWorkspaces();

      expect(result.map((entry) => entry.name)).toEqual(['good']);
      expect(warn).toHaveBeenCalledTimes(1);
      // The warning is the only trace of a dropped workspace, so it must name
      // the workspace and carry the real parse/schema detail — a bare
      // "skipping a workspace" leaves the user with nothing to fix.
      const [message] = warn.mock.calls[0] ?? [];
      expect(message).toBe(
        "Warning: skipping invalid workspace 'broken': Invalid workspace configuration:\n"
        + '  projects: Invalid type: Expected Array but received "not-an-array"',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('loadWorkspace, workspaceExists and deleteWorkspace', () => {
  let tmpDir: string;
  let wsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-ws-crud-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('loadWorkspace parses an existing workspace, applying schema defaults', () => {
    fs.writeFileSync(path.join(wsDir, 'demo.yaml'), 'profile: node-dev\nprojects: [/tmp/demo]\n');

    const workspace = loadWorkspace('demo');

    expect(workspace.profile).toBe('node-dev');
    expect(workspace.projects).toEqual(['/tmp/demo']);
    expect(workspace.stopAfterLastSession).toBe('30s');
  });

  test('loadWorkspace names the missing file and points at pi-tin list', () => {
    expect(() => loadWorkspace('ghost')).toThrow(
      `Workspace 'ghost' not found at ${path.join(wsDir, 'ghost.yaml')}\n${NOT_FOUND_HINT}`,
    );
  });

  test('workspaceExists reports only workspaces with a file on disk', () => {
    fs.writeFileSync(path.join(wsDir, 'demo.yaml'), 'profile: node-dev\nprojects: []\n');

    expect(workspaceExists('demo')).toBe(true);
    expect(workspaceExists('ghost')).toBe(false);
  });

  test('deleteWorkspace removes the file and leaves its siblings alone', () => {
    fs.writeFileSync(path.join(wsDir, 'demo.yaml'), 'profile: node-dev\nprojects: []\n');
    fs.writeFileSync(path.join(wsDir, 'keep.yaml'), 'profile: node-dev\nprojects: []\n');

    deleteWorkspace('demo');

    expect(fs.existsSync(path.join(wsDir, 'demo.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(wsDir, 'keep.yaml'))).toBe(true);
  });

  test('deleteWorkspace names the missing workspace and points at pi-tin list', () => {
    expect(() => deleteWorkspace('ghost')).toThrow(
      `Workspace 'ghost' not found.\n${NOT_FOUND_HINT}`,
    );
  });

  test('deleteWorkspace rejects a traversing name before touching the filesystem', () => {
    fs.writeFileSync(path.join(tmpDir, 'pi-tin', 'config.yaml'), 'shell: zsh\n');

    expect(() => deleteWorkspace('../config')).toThrow(invalidNameMessage('../config'));
    expect(fs.existsSync(path.join(tmpDir, 'pi-tin', 'config.yaml'))).toBe(true);
  });
});

describe('appendProjectToWorkspace', () => {
  let tmpDir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-ws-'));
    prevXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'pi-tin', 'workspaces'), { recursive: true });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prevXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWs(name: string, content: string): string {
    const p = path.join(tmpDir, 'pi-tin', 'workspaces', `${name}.yaml`);
    fs.writeFileSync(p, content);
    return p;
  }

  test('appends a project and preserves comments and formatting', () => {
    const p = writeWs('work', 'profile: node-dev\nprojects:\n  - /a/my-app # primary\nstopAfterLastSession: 30s\n');
    appendProjectToWorkspace('work', '/b/new-app');
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('# primary');
    expect(out).toContain('- /a/my-app');
    expect(out).toContain('- /b/new-app');
    expect(out).toContain('stopAfterLastSession: 30s');
  });

  test('creates the projects list when it is empty, leaving the other keys intact', () => {
    const p = writeWs('work', 'profile: node-dev\nprojects:\nstopAfterLastSession: 30s\n');
    appendProjectToWorkspace('work', '/b/new-app');
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('- /b/new-app');
    // Rewriting the document, rather than re-serialising a parsed object, is
    // the point of the doc-preserving implementation: the sibling keys must
    // survive the edit untouched.
    expect(out).toContain('profile: node-dev');
    expect(out).toContain('stopAfterLastSession: 30s');
    expect(loadWorkspace('work').stopAfterLastSession).toBe('30s');
  });

  test('names the missing workspace and points at pi-tin list', () => {
    const wsPath = path.join(tmpDir, 'pi-tin', 'workspaces', 'ghost.yaml');
    expect(() => appendProjectToWorkspace('ghost', '/b/new-app')).toThrow(
      `Workspace 'ghost' not found at ${wsPath}\n${NOT_FOUND_HINT}`,
    );
  });
});

describe('writeWorkspace name validation', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
    tools: [],
    sshd: false,
    attach: 'shell' as const,
    stopAfterLastSession: '30s',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalEnv = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    const piTinWsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
    fs.mkdirSync(piTinWsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalEnv;
    }
  });

  test('accepts valid workspace names', () => {
    expect(() => writeWorkspace('my-project', baseWorkspace)).not.toThrow();
    expect(() => writeWorkspace('app_v2', baseWorkspace)).not.toThrow();
    expect(() => writeWorkspace('test.env', baseWorkspace)).not.toThrow();
  });

  // The regex itself is owned by assertValidWorkspaceName; this is the wiring
  // pin — every write path runs the guard and surfaces the instructive rule.
  test('rejects invalid names with a message naming the name and restating the rule', () => {
    for (const name of ['MyProject', 'my project', 'my!project', '', '.hidden', '-bad', '../escape']) {
      expect(() => writeWorkspace(name, baseWorkspace)).toThrow(invalidNameMessage(name));
    }
  });

  // chmod is advisory for uid 0, so the read-only premise — and with it the
  // discriminating power of the test — does not exist under root.
  test.skipIf(process.getuid?.() === 0)(
    'writes atomically: replaces the file via rename and leaves no temp files',
    () => {
      writeWorkspace('my-project', baseWorkspace);
      const wsDir = path.join(tmpDir, 'pi-tin', 'workspaces');
      const wsPath = path.join(wsDir, 'my-project.yaml');
      // A rename-based write only needs directory permissions, so it succeeds
      // even when the previous file is read-only; an in-place truncating write
      // would fail here (and could leave a corrupt file on a crash).
      fs.chmodSync(wsPath, 0o444);

      const updated = { ...baseWorkspace, stopAfterLastSession: '60s' };
      expect(() => writeWorkspace('my-project', updated)).not.toThrow();
      expect(loadWorkspace('my-project').stopAfterLastSession).toBe('60s');
      expect(fs.readdirSync(wsDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    },
  );

  test('loadWorkspace rejects invalid names before touching the filesystem', () => {
    expect(() => loadWorkspace('../escape')).toThrow(invalidNameMessage('../escape'));
    expect(() => loadWorkspace('foo/bar')).toThrow(invalidNameMessage('foo/bar'));
    expect(() => loadWorkspace('MyProject')).toThrow(invalidNameMessage('MyProject'));
  });

  test('rejects a name too long to back a container', () => {
    expect(() => writeWorkspace('a'.repeat(56), baseWorkspace)).not.toThrow();
    expect(() => writeWorkspace('a'.repeat(57), baseWorkspace)).toThrow(
      /too long.*64-character container name.*limit is 63/,
    );
  });

  // The length guard deliberately lives here and not in the shared name rule,
  // so a workspace written by an older pi-tin — before the guard existed —
  // does not become impossible to remove.
  test('an over-long workspace from an older pi-tin stays loadable and deletable', () => {
    const legacyName = 'a'.repeat(60);
    const wsPath = path.join(tmpDir, 'pi-tin', 'workspaces', `${legacyName}.yaml`);
    fs.writeFileSync(wsPath, YAML.stringify(baseWorkspace));

    expect(loadWorkspace(legacyName).profile).toBe('default');
    expect(() => deleteWorkspace(legacyName)).not.toThrow();
    expect(fs.existsSync(wsPath)).toBe(false);
  });
});
