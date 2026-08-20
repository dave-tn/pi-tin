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
import { KNOWN_AGENTS } from './agents.js';
import type { KnownAgent } from './agents.js';

// User-authored definitions once merged into the table: one ordinary agent and
// one that refuses host mode. createAgentProfile reads whatever table it is
// handed, so these exercise the custom half without touching the real config.
const OH_MY_PI: KnownAgent = {
  name: 'oh-my-pi',
  package: 'oh-my-pi@latest',
  binary: 'ohmypi',
  dot_dirs: ['.oh-my-pi'],
  host_mode_supported: true,
  install: { method: 'npm' },
  container_env: {},
  api_key_vars: [],
  isolated_seed_files: [{ path: '.oh-my-pi/trust.json', content: '{}\n' }],
};

const NO_HOST: KnownAgent = {
  name: 'NoHost',
  package: 'nohost-agent@latest',
  binary: 'nohost',
  dot_dirs: ['.nohost'],
  host_mode_supported: false,
  install: { method: 'npm' },
  container_env: {},
  api_key_vars: [],
  isolated_seed_files: [],
};

const MERGED_AGENTS: readonly KnownAgent[] = [...KNOWN_AGENTS, OH_MY_PI, NO_HOST];

// Exact-message assertions: `toThrow(string)` matches a substring, so a
// message that merely starts with the expected text would pass.
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw');
}

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
    // Pins what an isolated profile gets: the metadata and the dot-dirs.
    test('creates an isolated profile directory with metadata and dot-dir', () => {
      createAgentProfile('personal', 'Claude Code', 'isolated', KNOWN_AGENTS);
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'personal');
      expect(fs.existsSync(profileDir)).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, '.claude'))).toBe(true);
      expect(fs.statSync(path.join(profileDir, '.claude')).isDirectory()).toBe(true);

      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: isolated');
      expect(yaml).toContain('.claude');
    });

    // Hand-written literal, not the imported message builder, so a copy
    // regression fails here. The remediation tail is the only route a user has
    // from "not in the list" to a custom agent of their own.
    test('throws for unknown agent name, listing known agents and how to add one', () => {
      expect(thrownMessage(() => createAgentProfile('test', 'Unknown Agent', 'isolated', KNOWN_AGENTS)))
        .toBe(
          "Unknown agent: 'Unknown Agent'. Known agents: Claude Code, Pi, Codex, OpenCode, Amp, Copilot, Crush, "
          + 'Antigravity. To add a custom agent, define it with `pi-tin agent apply <name>` — '
          + '`pi-tin agent show "Claude Code"` prints a template (README: Custom agents).',
        );
    });

    test('lists custom agents from the merged table in the unknown-agent message', () => {
      expect(thrownMessage(() => createAgentProfile('test', 'Unknown Agent', 'isolated', MERGED_AGENTS)))
        .toBe(
          "Unknown agent: 'Unknown Agent'. Known agents: Claude Code, Pi, Codex, OpenCode, Amp, Copilot, Crush, "
          + 'Antigravity, oh-my-pi, NoHost. To add a custom agent, define it with `pi-tin agent apply <name>` — '
          + '`pi-tin agent show "Claude Code"` prints a template (README: Custom agents).',
        );
    });

    test('creates an isolated profile for a custom agent, with its dot-dir and seed file', () => {
      createAgentProfile('mine', 'oh-my-pi', 'isolated', MERGED_AGENTS);
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'mine');
      expect(fs.statSync(path.join(profileDir, '.oh-my-pi')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(profileDir, '.oh-my-pi', 'trust.json'), 'utf-8')).toBe('{}\n');
      expect(loadAgentProfile('mine')).toMatchObject({
        agent: 'oh-my-pi',
        mode: 'isolated',
        mounts: ['.oh-my-pi'],
      });
    });

    test('throws if profile already exists, naming the profile and its directory', () => {
      createAgentProfile('personal', 'Claude Code', 'isolated', KNOWN_AGENTS);
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'personal');
      expect(() => createAgentProfile('personal', 'Claude Code', 'isolated', KNOWN_AGENTS))
        .toThrow(`Agent profile 'personal' already exists at ${profileDir}`);
    });

    test('recreates a profile after an interrupted creation left no profile.yaml', () => {
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'partial');
      fs.mkdirSync(path.join(profileDir, '.claude'), { recursive: true });
      // No profile.yaml — simulates a creation that died mid-way. Retrying
      // must succeed instead of trapping the user with "already exists".
      expect(() => createAgentProfile('partial', 'Claude Code', 'isolated', KNOWN_AGENTS)).not.toThrow();
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
    });
  });

  describe('loadAgentProfile', () => {
    test('loads a created profile', () => {
      createAgentProfile('work', 'Claude Code', 'isolated', KNOWN_AGENTS);
      const profile = loadAgentProfile('work');
      expect(profile.agent).toBe('Claude Code');
      expect(profile.mode).toBe('isolated');
      expect(profile.mounts).toContain('.claude');
    });

    test('throws for non-existent profile, naming it and how to list profiles', () => {
      expect(() => loadAgentProfile('missing')).toThrow(
        "Agent profile 'missing' not found. Run 'pi-tin agent-profile list' to see available profiles.",
      );
    });
  });

  describe('listAgentProfiles', () => {
    test('returns empty array when no profiles exist', () => {
      expect(listAgentProfiles()).toEqual([]);
    });

    test('returns all profiles', () => {
      createAgentProfile('personal', 'Claude Code', 'isolated', KNOWN_AGENTS);
      createAgentProfile('work-codex', 'Codex', 'isolated', KNOWN_AGENTS);
      const profiles = listAgentProfiles();
      expect(profiles.map((p) => p.name).sort()).toEqual(['personal', 'work-codex']);
    });

    test('warns about an invalid profile but still returns the valid ones', () => {
      createAgentProfile('good', 'Claude Code', 'isolated', KNOWN_AGENTS);
      const badDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'broken');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'profile.yaml'), 'not: a: valid: profile', 'utf-8');

      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const profiles = listAgentProfiles();
        expect(profiles.map((p) => p.name)).toEqual(['good']);
        expect(warn).toHaveBeenCalledTimes(1);
        // The warning must name the skipped profile AND carry the underlying
        // parse failure through — a generic "invalid profile" leaves the user
        // with nothing to fix.
        expect(warn.mock.calls[0]?.[0]).toContain(
          "Warning: skipping invalid agent profile 'broken': Failed to parse YAML at ",
        );
        expect(warn.mock.calls[0]?.[0]).toContain(path.join(badDir, 'profile.yaml'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('deleteAgentProfile', () => {
    test('removes the profile directory', () => {
      createAgentProfile('temp', 'Claude Code', 'isolated', KNOWN_AGENTS);
      deleteAgentProfile('temp');
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'temp');
      expect(fs.existsSync(profileDir)).toBe(false);
    });

    test('throws for non-existent profile, naming it', () => {
      expect(() => deleteAgentProfile('missing')).toThrow("Agent profile 'missing' not found.");
    });
  });

  describe('path-unsafe profile names', () => {
    test.each(['../x', 'a/b', 'a\\b', '.', '..', ''])(
      "create/load/delete reject '%s'",
      (name) => {
        expect(() => createAgentProfile(name, 'Claude Code', 'isolated', KNOWN_AGENTS)).toThrow(
          `Invalid agent profile name '${name}'`,
        );
        expect(() => loadAgentProfile(name)).toThrow(`Invalid agent profile name '${name}'`);
        expect(() => deleteAgentProfile(name)).toThrow(`Invalid agent profile name '${name}'`);
      },
    );

    // No charset rule: existing profiles may contain uppercase, dots, etc.
    test('names with uppercase and dots pass the guard', () => {
      createAgentProfile('My.Claude_v2', 'Claude Code', 'isolated', KNOWN_AGENTS);
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
      createAgentProfile('my-claude', 'Claude Code', 'isolated', KNOWN_AGENTS);
      createAgentProfile('my-codex', 'Codex', 'isolated', KNOWN_AGENTS);
      expect(() => validateAgentProfilesForWorkspace(['my-claude', 'my-codex'])).not.toThrow();
    });

    test('throws for missing profile, naming the profile that is missing', () => {
      expect(() => validateAgentProfilesForWorkspace(['nonexistent'])).toThrow(
        "Agent profile 'nonexistent' not found. Run 'pi-tin agent-profile list' to see available profiles.",
      );
    });

    test('throws for conflicting dot-dirs, naming the mount and both profiles', () => {
      createAgentProfile('claude1', 'Claude Code', 'isolated', KNOWN_AGENTS);
      createAgentProfile('claude2', 'Claude Code', 'isolated', KNOWN_AGENTS);
      expect(() => validateAgentProfilesForWorkspace(['claude1', 'claude2'])).toThrow(
        'Workspace has multiple agent profiles for .claude: claude1, claude2. '
        + 'Only one agent profile per mount path is allowed.',
      );
    });

    test('passes with empty list', () => {
      expect(() => validateAgentProfilesForWorkspace([])).not.toThrow();
    });
  });

  describe('createAgentProfile with mode', () => {
    test('creates host profile with no mount directories', () => {
      createAgentProfile('pi-host', 'Pi', 'host', KNOWN_AGENTS);
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'pi-host');
      expect(fs.existsSync(path.join(profileDir, 'profile.yaml'))).toBe(true);
      // Host profiles do NOT create dot-directories or seed files (trust
      // decisions in the shared host ~/.pi stay the user's own)
      expect(fs.existsSync(path.join(profileDir, '.pi'))).toBe(false);

      const yaml = fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf-8');
      expect(yaml).toContain('mode: host');
    });

    test('isolated Pi profile seeds trust.json pre-trusting /workspace', () => {
      createAgentProfile('pi-personal', 'Pi', 'isolated', KNOWN_AGENTS);
      const trustPath = path.join(
        tmpDir, 'pi-tin', 'agent-profiles', 'pi-personal', '.pi', 'agent', 'trust.json',
      );
      expect(JSON.parse(fs.readFileSync(trustPath, 'utf-8'))).toEqual({ '/workspace': true });
    });

    test('creates isolated profile with multiple mount directories', () => {
      createAgentProfile('oc', 'OpenCode', 'isolated', KNOWN_AGENTS);
      const profileDir = path.join(tmpDir, 'pi-tin', 'agent-profiles', 'oc');
      expect(fs.existsSync(path.join(profileDir, '.local/share/opencode'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, '.config/opencode'))).toBe(true);
    });

    // Generic by design: a custom definition may refuse host mode for reasons
    // that have nothing to do with the macOS Keychain, so the refusal states
    // the fact and leaves the rationale to README.
    test('throws when creating host profile for unsupported agent, naming the agent', () => {
      expect(thrownMessage(() => createAgentProfile('test', 'Claude Code', 'host', KNOWN_AGENTS)))
        .toBe('Claude Code does not support host mode.');
    });

    test('refuses host mode for a custom agent that declares it unsupported', () => {
      expect(thrownMessage(() => createAgentProfile('nh', 'NoHost', 'host', MERGED_AGENTS)))
        .toBe('NoHost does not support host mode.');
      expect(fs.existsSync(path.join(tmpDir, 'pi-tin', 'agent-profiles', 'nh'))).toBe(false);
    });
  });

  describe('validateAgentProfilesForWorkspace with modes', () => {
    test('resolves isolated profile paths from profile directory', () => {
      createAgentProfile('my-claude', 'Claude Code', 'isolated', KNOWN_AGENTS);
      const result = validateAgentProfilesForWorkspace(['my-claude']);
      expect(result).toHaveLength(1);
      expect(result[0]!.mount).toBe('.claude');
      expect(result[0]!.hostPath).toContain('agent-profiles/my-claude/.claude');
    });

    test('resolves host profile paths from home directory', () => {
      createAgentProfile('pi-host', 'Pi', 'host', KNOWN_AGENTS);
      const result = validateAgentProfilesForWorkspace(['pi-host']);
      expect(result).toHaveLength(1);
      expect(result[0]!.mount).toBe('.pi');
      expect(result[0]!.hostPath).toBe(path.join(os.homedir(), '.pi'));
    });

    test('resolves multiple mounts for one profile', () => {
      createAgentProfile('oc', 'OpenCode', 'isolated', KNOWN_AGENTS);
      const result = validateAgentProfilesForWorkspace(['oc']);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.mount).sort()).toEqual([
        '.config/opencode',
        '.local/share/opencode',
      ]);
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
