import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import {
  findWorkspacesForDirectory,
  writeWorkspace,
  loadWorkspace,
  isValidWorkspaceName,
  assertValidWorkspaceName,
  appendProjectToWorkspace,
  WORKSPACE_NAME_RULE,
} from './workspaces.js';

describe('isValidWorkspaceName', () => {
  test('accepts valid names', () => {
    expect(isValidWorkspaceName('my-project')).toBe(true);
    expect(isValidWorkspaceName('app_v2')).toBe(true);
    expect(isValidWorkspaceName('test.env')).toBe(true);
    expect(isValidWorkspaceName('a')).toBe(true);
  });

  test('rejects invalid names', () => {
    expect(isValidWorkspaceName('MyProject')).toBe(false);
    expect(isValidWorkspaceName('my project')).toBe(false);
    expect(isValidWorkspaceName('my!project')).toBe(false);
    expect(isValidWorkspaceName('')).toBe(false);
    expect(isValidWorkspaceName('.hidden')).toBe(false);
    expect(isValidWorkspaceName('-bad')).toBe(false);
    expect(isValidWorkspaceName('../escape')).toBe(false);
  });
});

describe('assertValidWorkspaceName', () => {
  test('passes valid names through silently', () => {
    expect(() => assertValidWorkspaceName('my-project')).not.toThrow();
    expect(() => assertValidWorkspaceName('app_v2')).not.toThrow();
  });

  test('throws the instructive name rule for invalid names', () => {
    for (const name of ['../escape', 'MyProject', 'my project', '']) {
      expect(() => assertValidWorkspaceName(name)).toThrow(WORKSPACE_NAME_RULE);
    }
  });

  test('names the offending workspace in the error', () => {
    expect(() => assertValidWorkspaceName('../escape')).toThrow("Invalid workspace name '../escape'");
  });
});

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

  test('creates the projects list when it is empty', () => {
    const p = writeWs('work', 'profile: node-dev\nprojects:\nstopAfterLastSession: 30s\n');
    appendProjectToWorkspace('work', '/b/new-app');
    expect(fs.readFileSync(p, 'utf-8')).toContain('- /b/new-app');
  });
});

describe('writeWorkspace name validation', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  const baseWorkspace = {
    profile: 'default',
    projects: ['/tmp/test'],
    tools: [],
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

  test('rejects uppercase names', () => {
    expect(() => writeWorkspace('MyProject', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('rejects names with spaces', () => {
    expect(() => writeWorkspace('my project', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('rejects names with special characters', () => {
    expect(() => writeWorkspace('my!project', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('rejects empty name', () => {
    expect(() => writeWorkspace('', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('rejects names starting with dot', () => {
    expect(() => writeWorkspace('.hidden', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('rejects names starting with hyphen', () => {
    expect(() => writeWorkspace('-bad', baseWorkspace)).toThrow(/workspace name/i);
  });

  test('writes atomically: replaces the file via rename and leaves no temp files', () => {
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
  });

  test('loadWorkspace rejects invalid names before touching the filesystem', () => {
    expect(() => loadWorkspace('../escape')).toThrow(/workspace name/i);
    expect(() => loadWorkspace('foo/bar')).toThrow(/workspace name/i);
    expect(() => loadWorkspace('MyProject')).toThrow(/workspace name/i);
  });
});
