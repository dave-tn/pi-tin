import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncDefaultContainerProfiles } from './init-guard.js';
import { getContainerProfilesDir } from './paths.js';
import {
  listContainerProfileSummaries,
  loadContainerProfile,
  listContainerProfiles,
  planContainerProfileDelete,
} from './profiles.js';

const PROFILE_YAML = `
description: Test profile
base_image: node:22-slim
user: dev
packages: []
extra_packages: []
global_tools: []
post_install: []
env: {}
`;

describe('profiles', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'pi-tin', 'profiles'), { recursive: true });
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProfile(name: string): void {
    fs.writeFileSync(path.join(tmpDir, 'pi-tin', 'profiles', `${name}.yaml`), PROFILE_YAML);
  }

  describe('loadContainerProfile', () => {
    test('loads an existing profile', () => {
      writeProfile('node-dev');
      const profile = loadContainerProfile('node-dev');
      expect(profile.base_image).toBe('node:22-slim');
    });

    // No charset rule: existing profiles may contain uppercase, dots, etc.
    test('loads profiles whose names contain uppercase and dots', () => {
      writeProfile('My.Profile_v2');
      expect(loadContainerProfile('My.Profile_v2').user).toBe('dev');
    });

    test('throws for a missing profile', () => {
      expect(() => loadContainerProfile('missing')).toThrow("Container profile 'missing' not found");
    });

    test.each(['../x', 'a/b', 'a\\b', '.', '..', ''])(
      "rejects path-unsafe name '%s'",
      (name) => {
        expect(() => loadContainerProfile(name)).toThrow(`Invalid container profile name '${name}'`);
      },
    );

    test('does not read outside the profiles dir for traversal names', () => {
      fs.writeFileSync(path.join(tmpDir, 'pi-tin', 'escaped.yaml'), PROFILE_YAML);
      expect(() => loadContainerProfile('../escaped')).toThrow('Invalid container profile name');
    });
  });

  describe('listContainerProfiles', () => {
    test('returns sorted profile names', () => {
      writeProfile('beta');
      writeProfile('alpha');
      expect(listContainerProfiles()).toEqual(['alpha', 'beta']);
    });

    test('returns empty array when the directory does not exist', () => {
      fs.rmSync(path.join(tmpDir, 'pi-tin', 'profiles'), { recursive: true, force: true });
      expect(listContainerProfiles()).toEqual([]);
    });
  });
});

describe('listContainerProfileSummaries', () => {
  let tmp: string;
  const prev = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-profiles-'));
    process.env['XDG_CONFIG_HOME'] = tmp;
    syncDefaultContainerProfiles(getContainerProfilesDir());
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns a structured summary for each default profile', () => {
    const summaries = listContainerProfileSummaries();
    const names = summaries.map((s) => s.name);
    expect(names).toContain('node-dev');

    const node = summaries.find((s) => s.name === 'node-dev');
    expect(node).toBeDefined();
    expect(node?.valid).toBe(true);
    expect(node?.base_image).toBe('node:trixie-slim');
    expect(typeof node?.description).toBe('string');
  });

  test('marks an unparseable profile invalid rather than throwing', () => {
    fs.writeFileSync(
      path.join(getContainerProfilesDir(), 'broken.yaml'),
      'base_image: 123\n',
      'utf-8',
    );
    const broken = listContainerProfileSummaries().find((s) => s.name === 'broken');
    expect(broken).toBeDefined();
    expect(broken?.valid).toBe(false);
  });
});

describe('writeContainerProfile', () => {
  let tmp: string;
  const prev = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-write-'));
    process.env['XDG_CONFIG_HOME'] = tmp;
    syncDefaultContainerProfiles(getContainerProfilesDir());
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('writeContainerProfile round-trips through loadContainerProfile', async () => {
    const { writeContainerProfile, loadContainerProfile } = await import('./profiles.js');
    const profile = loadContainerProfile('node-dev');
    const edited = { ...profile, description: 'edited by test' };
    writeContainerProfile('node-dev', edited);
    expect(loadContainerProfile('node-dev').description).toBe('edited by test');
  });

  test('writeContainerProfile output has no managed header', async () => {
    const { writeContainerProfile } = await import('./profiles.js');
    const fsmod = await import('node:fs');
    const pathmod = await import('node:path');
    const { getContainerProfilesDir } = await import('./paths.js');
    const profile = (await import('./profiles.js')).loadContainerProfile('bun-dev');
    writeContainerProfile('bun-dev', profile);
    const written = fsmod.readFileSync(
      pathmod.join(getContainerProfilesDir(), 'bun-dev.yaml'),
      'utf-8',
    );
    expect(written.startsWith('# This profile is managed by pi-tin')).toBe(false);
  });
});

describe('planContainerProfileDelete', () => {
  test('no referencing workspaces', () => {
    expect(planContainerProfileDelete({ name: 'default', workspaces: [] })).toEqual({
      action: 'delete',
      profile: 'default',
      referencedBy: [],
      removes: 'the container profile definition',
    });
  });

  test('lists only workspaces whose profile matches, sorted by name', () => {
    expect(planContainerProfileDelete({
      name: 'rust',
      workspaces: [
        { name: 'zeta', profile: 'rust' },
        { name: 'alpha', profile: 'node' },
        { name: 'beta', profile: 'rust' },
      ],
    })).toEqual({
      action: 'delete',
      profile: 'rust',
      referencedBy: ['beta', 'zeta'],
      removes: 'the container profile definition',
    });
  });
});
