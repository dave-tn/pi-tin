import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { containerHomeDir, findProjectRoot, getAgentProfilesDir, getUpdateCheckPath, isSafePathSegment, isWithinDir } from './paths.js';

describe('isSafePathSegment', () => {
  test('accepts names without a charset rule', () => {
    for (const name of ['default', 'My Profile', 'v1.2', 'claude-host', '..x', 'A_B']) {
      expect(isSafePathSegment(name)).toBe(true);
    }
  });

  test('rejects names that could escape their parent directory', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', '../x', '..\\x', '/abs']) {
      expect(isSafePathSegment(name)).toBe(false);
    }
  });
});

describe('isWithinDir', () => {
  const parent = path.join(path.sep, 'a', 'b');

  test('true for the directory itself', () => {
    expect(isWithinDir(parent, parent)).toBe(true);
  });

  test('true for a nested child', () => {
    expect(isWithinDir(path.join(parent, 'c', 'd'), parent)).toBe(true);
  });

  test('false for a sibling sharing a name prefix', () => {
    expect(isWithinDir(path.join(path.sep, 'a', 'bc'), parent)).toBe(false);
  });

  test('false for the parent of the directory', () => {
    expect(isWithinDir(path.join(path.sep, 'a'), parent)).toBe(false);
  });

  test('false for an unrelated path', () => {
    expect(isWithinDir(path.join(path.sep, 'x', 'y'), parent)).toBe(false);
  });

  test('trailing separators are not normalised away — callers must resolve first', () => {
    expect(isWithinDir(parent + path.sep, parent)).toBe(true);
    expect(isWithinDir(parent, parent + path.sep)).toBe(false);
    expect(isWithinDir(path.resolve(parent + path.sep), parent)).toBe(true);
  });
});

describe('containerHomeDir', () => {
  test('returns /root for the root user', () => {
    expect(containerHomeDir('root')).toBe('/root');
  });

  test('returns /home/<user> for non-root users', () => {
    expect(containerHomeDir('dev')).toBe('/home/dev');
  });
});

describe('findProjectRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns directory containing .git when found', () => {
    const repoDir = path.join(tmpDir, 'my-repo');
    const subDir = path.join(repoDir, 'src', 'lib');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    expect(findProjectRoot(subDir)).toBe(repoDir);
  });

  test('returns cwd when no .git found', () => {
    const noGitDir = path.join(tmpDir, 'no-repo', 'deep');
    fs.mkdirSync(noGitDir, { recursive: true });

    expect(findProjectRoot(noGitDir)).toBe(noGitDir);
  });

  test('returns exact directory when .git is in cwd', () => {
    const repoDir = path.join(tmpDir, 'my-repo');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

    expect(findProjectRoot(repoDir)).toBe(repoDir);
  });
});

describe('getAgentProfilesDir', () => {
  test('returns agent-profiles subdirectory of config dir', () => {
    const dir = getAgentProfilesDir();
    expect(dir).toContain('pi-tin');
    expect(dir.endsWith('/agent-profiles')).toBe(true);
  });
});

describe('getUpdateCheckPath', () => {
  const original = process.env['XDG_CONFIG_HOME'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = original;
    }
  });

  test('lives under the state dir honoring XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-example';
    expect(getUpdateCheckPath()).toBe('/tmp/xdg-example/pi-tin/state/update-check.json');
  });
});
