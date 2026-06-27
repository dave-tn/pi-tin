import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { containerHomeDir, findProjectRoot, getAgentProfilesDir, isSafePathSegment } from './paths.js';

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
