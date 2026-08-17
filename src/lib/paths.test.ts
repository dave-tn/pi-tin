import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { containerHomeDir, findCaseFoldingStem, findCaseFoldingStemOnDisk, findProjectRoot, getAgentDefinitionsDir, getAgentProfilesDir, getUpdateCheckPath, getWorkspaceStateDir, isSafePathSegment, isWithinDir } from './paths.js';

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

describe('findCaseFoldingStem', () => {
  test('allows the stem that is exactly the one already there', () => {
    expect(findCaseFoldingStem('omp', ['omp', 'other'])).toBeUndefined();
  });

  test('allows a stem with no sibling in any case', () => {
    expect(findCaseFoldingStem('OMP', ['other', 'another'])).toBeUndefined();
  });

  test('allows a stem when nothing is there', () => {
    expect(findCaseFoldingStem('OMP', [])).toBeUndefined();
  });

  test('reports the existing stem a case-variant would fold onto', () => {
    expect(findCaseFoldingStem('OMP', ['other', 'omp'])).toBe('omp');
    expect(findCaseFoldingStem('Omp', ['oMP'])).toBe('oMP');
  });

  // Only a case-sensitive volume can hold both, and then the exact stem is the
  // update target — the variant beside it is a different entity, left alone.
  test('allows the exact stem even when a case-variant sits beside it', () => {
    expect(findCaseFoldingStem('OMP', ['omp', 'OMP'])).toBeUndefined();
  });
});

describe('findCaseFoldingStemOnDisk', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-case-fold-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('treats a missing directory as empty', () => {
    expect(findCaseFoldingStemOnDisk('omp', path.join(tmpDir, 'absent'))).toBeUndefined();
  });

  // The stems must come from a directory read compared exactly: an
  // fs.existsSync of the target path folds case on a case-insensitive volume,
  // so it would answer "the exact stem is there" for this very pair.
  test('catches a case-variant and still allows the exact stem', () => {
    fs.writeFileSync(path.join(tmpDir, 'omp.yaml'), 'package: omp@latest\n');

    expect(findCaseFoldingStemOnDisk('OMP', tmpDir)).toBe('omp');
    expect(findCaseFoldingStemOnDisk('omp', tmpDir)).toBeUndefined();
  });

  // Only `*.yaml` files are loadable, so nothing else can be folded onto.
  test('ignores entries that are not yaml files', () => {
    fs.writeFileSync(path.join(tmpDir, 'omp.txt'), '');
    fs.mkdirSync(path.join(tmpDir, 'nested.yaml'));

    expect(findCaseFoldingStemOnDisk('OMP', tmpDir)).toBeUndefined();
    expect(findCaseFoldingStemOnDisk('Nested', tmpDir)).toBeUndefined();
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
  const original = process.env['XDG_CONFIG_HOME'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = original;
    }
  });

  test('lives under the config dir honoring XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-example';
    expect(getAgentProfilesDir()).toBe('/tmp/xdg-example/pi-tin/agent-profiles');
  });
});

describe('getAgentDefinitionsDir', () => {
  const original = process.env['XDG_CONFIG_HOME'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = original;
    }
  });

  test('lives under the config dir honoring XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-example';
    expect(getAgentDefinitionsDir()).toBe('/tmp/xdg-example/pi-tin/agents');
  });
});

describe('getWorkspaceStateDir', () => {
  const original = process.env['XDG_CONFIG_HOME'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = original;
    }
  });

  test('lives under a per-workspace subdir of the config dir honoring XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-example';
    expect(getWorkspaceStateDir('myws')).toBe('/tmp/xdg-example/pi-tin/workspace-state/myws');
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
