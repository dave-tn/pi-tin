import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createAgentProfile,
  loadAgentProfile,
  listAgentProfiles,
  deleteAgentProfile,
  planAgentProfileDelete,
  validateAgentProfilesForWorkspace,
} from './agent-profiles.js';

describe('agent-profiles', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'pi-tin', 'agent-profiles'), { recursive: true });
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createAgentProfile', () => {
    test('creates profile directory with metadata and dot-dir', () => {
      createAgentProfile('personal', 'Claude Code');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'personal');
      expect(fs.existsSync(profileDir)).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, '.claude'))).toBe(true);
      expect(fs.statSync(path.join(profileDir, '.claude')).isDirectory()).toBe(true);

      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: isolated');
      expect(yaml).toContain('.claude');
    });

    test('throws for unknown agent name', () => {
      expect(() => createAgentProfile('test', 'Unknown Agent')).toThrow('Unknown agent');
    });

    test('throws if profile already exists', () => {
      createAgentProfile('personal', 'Claude Code');
      expect(() => createAgentProfile('personal', 'Claude Code')).toThrow('already exists');
    });

    test('recreates a profile after an interrupted creation left no profile.yaml', () => {
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'partial');
      fs.mkdirSync(path.join(profileDir, '.claude'), { recursive: true });
      // No profile.yaml — simulates a creation that died mid-way. Retrying
      // must succeed instead of trapping the user with "already exists".
      expect(() => createAgentProfile('partial', 'Claude Code')).not.toThrow();
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
    });
  });

  describe('loadAgentProfile', () => {
    test('loads a created profile', () => {
      createAgentProfile('work', 'Claude Code');
      const profile = loadAgentProfile('work');
      expect(profile.agent).toBe('Claude Code');
      expect(profile.mode).toBe('isolated');
      expect(profile.mounts).toContain('.claude');
    });

    test('throws for non-existent profile', () => {
      expect(() => loadAgentProfile('missing')).toThrow('not found');
    });
  });

  describe('listAgentProfiles', () => {
    test('returns empty array when no profiles exist', () => {
      expect(listAgentProfiles()).toEqual([]);
    });

    test('returns all profiles', () => {
      createAgentProfile('personal', 'Claude Code');
      createAgentProfile('work-codex', 'Codex');
      const profiles = listAgentProfiles();
      expect(profiles.map((p) => p.name).sort()).toEqual(['personal', 'work-codex']);
    });

    test('warns about an invalid profile but still returns the valid ones', () => {
      createAgentProfile('good', 'Claude Code');
      const badDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'broken');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'profile.yaml'), 'not: a: valid: profile', 'utf-8');

      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const profiles = listAgentProfiles();
        expect(profiles.map((p) => p.name)).toEqual(['good']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('broken');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('deleteAgentProfile', () => {
    test('removes the profile directory', () => {
      createAgentProfile('temp', 'Claude Code');
      deleteAgentProfile('temp');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'temp');
      expect(fs.existsSync(profileDir)).toBe(false);
    });

    test('throws for non-existent profile', () => {
      expect(() => deleteAgentProfile('missing')).toThrow('not found');
    });
  });

  describe('path-unsafe profile names', () => {
    test.each(['../x', 'a/b', 'a\\b', '.', '..', ''])(
      "create/load/delete reject '%s'",
      (name) => {
        expect(() => createAgentProfile(name, 'Claude Code')).toThrow(
          `Invalid agent profile name '${name}'`,
        );
        expect(() => loadAgentProfile(name)).toThrow(`Invalid agent profile name '${name}'`);
        expect(() => deleteAgentProfile(name)).toThrow(`Invalid agent profile name '${name}'`);
      },
    );

    // No charset rule: existing profiles may contain uppercase, dots, etc.
    test('names with uppercase and dots pass the guard', () => {
      createAgentProfile('My.Claude_v2', 'Claude Code');
      expect(loadAgentProfile('My.Claude_v2').agent).toBe('Claude Code');
      expect(() => deleteAgentProfile('My.Claude_v2')).not.toThrow();
    });

    test('delete never escapes the agent-profiles dir', () => {
      const outside = path.join(tmpDir, 'pi-tin', 'outside');
      fs.mkdirSync(outside, { recursive: true });
      expect(() => deleteAgentProfile('../outside')).toThrow('Invalid agent profile name');
      expect(fs.existsSync(outside)).toBe(true);
    });
  });

  describe('validateAgentProfilesForWorkspace', () => {
    test('passes with valid non-conflicting profiles', () => {
      createAgentProfile('my-claude', 'Claude Code');
      createAgentProfile('my-codex', 'Codex');
      expect(() => validateAgentProfilesForWorkspace(['my-claude', 'my-codex'])).not.toThrow();
    });

    test('throws for missing profile', () => {
      expect(() => validateAgentProfilesForWorkspace(['nonexistent'])).toThrow('not found');
    });

    test('throws for conflicting dot-dirs', () => {
      createAgentProfile('claude1', 'Claude Code');
      createAgentProfile('claude2', 'Claude Code');
      expect(() => validateAgentProfilesForWorkspace(['claude1', 'claude2'])).toThrow('multiple agent profiles');
    });

    test('passes with empty list', () => {
      expect(() => validateAgentProfilesForWorkspace([])).not.toThrow();
    });
  });

  describe('createAgentProfile with mode', () => {
    test('creates isolated profile with empty mount directories', () => {
      createAgentProfile('personal', 'Claude Code', 'isolated');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'personal');
      expect(fs.existsSync(path.join(profileDir, '.claude'))).toBe(true);

      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: isolated');
      expect(yaml).toContain('.claude');
    });

    test('creates host profile with no mount directories', () => {
      createAgentProfile('pi-host', 'Pi', 'host');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'pi-host');
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
      // Host profiles do NOT create dot-directories or seed files (trust
      // decisions in the shared host ~/.pi stay the user's own)
      expect(fs.existsSync(path.join(profileDir, '.pi'))).toBe(false);

      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: host');
    });

    test('isolated Pi profile seeds trust.json pre-trusting /workspace', () => {
      createAgentProfile('pi-personal', 'Pi', 'isolated');
      const trustPath = path.join(
        tmpDir, 'pi-tin', 'agent-profiles', 'pi-personal', '.pi', 'agent', 'trust.json',
      );
      expect(JSON.parse(fs.readFileSync(trustPath, 'utf-8'))).toEqual({ '/workspace': true });
    });

    test('creates isolated profile with multiple mount directories', () => {
      createAgentProfile('oc', 'OpenCode', 'isolated');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'oc');
      expect(fs.existsSync(path.join(profileDir, '.local/share/opencode'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, '.config/opencode'))).toBe(true);
    });

    test('throws when creating host profile for unsupported agent', () => {
      expect(() => createAgentProfile('test', 'Claude Code', 'host')).toThrow(
        'does not support host mode',
      );
    });

    test('defaults to isolated when mode not specified', () => {
      createAgentProfile('default-mode', 'Claude Code');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'default-mode');
      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: isolated');
    });
  });

  describe('validateAgentProfilesForWorkspace with modes', () => {
    test('resolves isolated profile paths from profile directory', () => {
      createAgentProfile('my-claude', 'Claude Code', 'isolated');
      const result = validateAgentProfilesForWorkspace(['my-claude']);
      expect(result).toHaveLength(1);
      expect(result[0]!.mount).toBe('.claude');
      expect(result[0]!.hostPath).toContain('agent-profiles/my-claude/.claude');
    });

    test('resolves host profile paths from home directory', () => {
      createAgentProfile('pi-host', 'Pi', 'host');
      const result = validateAgentProfilesForWorkspace(['pi-host']);
      expect(result).toHaveLength(1);
      expect(result[0]!.mount).toBe('.pi');
      expect(result[0]!.hostPath).toBe(path.join(os.homedir(), '.pi'));
    });

    test('resolves multiple mounts for one profile', () => {
      createAgentProfile('oc', 'OpenCode', 'isolated');
      const result = validateAgentProfilesForWorkspace(['oc']);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.mount).sort()).toEqual([
        '.config/opencode',
        '.local/share/opencode',
      ]);
    });

    test('throws for conflicting mounts across profiles', () => {
      createAgentProfile('claude1', 'Claude Code', 'isolated');
      createAgentProfile('claude2', 'Claude Code', 'isolated');
      expect(() => validateAgentProfilesForWorkspace(['claude1', 'claude2'])).toThrow('multiple agent profiles');
    });
  });
});

describe('planAgentProfileDelete', () => {
  test('reports referencing workspaces, sorted, with no references', () => {
    expect(planAgentProfileDelete({ name: 'claude', workspaces: [] })).toEqual({
      action: 'delete',
      profile: 'claude',
      referencedBy: [],
      removes: 'stored credentials and config',
    });
  });

  test('lists only workspaces that reference the profile, sorted by name', () => {
    expect(planAgentProfileDelete({
      name: 'claude',
      workspaces: [
        { name: 'zeta', agentProfiles: ['claude'] },
        { name: 'alpha', agentProfiles: ['other'] },
        { name: 'beta', agentProfiles: ['claude', 'other'] },
      ],
    })).toEqual({
      action: 'delete',
      profile: 'claude',
      referencedBy: ['beta', 'zeta'],
      removes: 'stored credentials and config',
    });
  });
});
