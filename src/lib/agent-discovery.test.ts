import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentProfileNameError,
  findConfiguredAgents,
  planDiscoveredAgentProfile,
} from './agent-discovery.js';
import { KNOWN_AGENTS } from './agents.js';
import type { KnownAgent } from './agents.js';

// findConfiguredAgents takes an explicit home in tests (os.homedir() may be
// cached, so $HOME overrides are unreliable) — the real home is never scanned.
let fakeHome: string;

// Stands in for a user-authored agent definition once it has been merged into
// the table: the scan must find its dot-dir like any built-in's.
const CUSTOM_AGENT: KnownAgent = {
  name: 'oh-my-pi',
  package: 'oh-my-pi@latest',
  binary: 'ohmypi',
  dot_dirs: ['.oh-my-pi'],
  host_mode_supported: true,
  install: { method: 'npm' },
  container_env: {},
  isolated_seed_files: [],
};

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-discovery-'));
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const mkdir = (relative: string): void => {
  fs.mkdirSync(path.join(fakeHome, relative), { recursive: true });
};

describe('findConfiguredAgents', () => {
  test('finds nothing in a home with no agent dot-directories', () => {
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome)).toEqual([]);
  });

  test('finds only the agent whose dot-directory exists', () => {
    mkdir('.claude');
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome).map((a) => a.name)).toEqual(['Claude Code']);
  });

  test('ignores a dot-path that is a file rather than a directory', () => {
    fs.writeFileSync(path.join(fakeHome, '.claude'), 'not a directory');
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome)).toEqual([]);
  });

  test('finds a multi-dot-dir agent when only one of its directories exists', () => {
    // OpenCode declares .local/share/opencode and .config/opencode; either
    // alone is enough signal (`some`, not `every`).
    mkdir('.config/opencode');
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome).map((a) => a.name)).toEqual(['OpenCode']);
  });

  // The scan reads the table it is handed, so a custom agent is discoverable
  // on exactly the same terms as a built-in.
  test('finds a custom agent from the merged table', () => {
    mkdir('.oh-my-pi');
    expect(findConfiguredAgents([...KNOWN_AGENTS, CUSTOM_AGENT], fakeHome).map((a) => a.name))
      .toEqual(['oh-my-pi']);
  });

  test('does not find a custom agent absent from the table it is given', () => {
    mkdir('.oh-my-pi');
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome)).toEqual([]);
  });

  // The scan stats the dot-path directly, so an unreadable parent makes the
  // stat throw EACCES. One unreadable dot-dir must not abort discovery for
  // every other agent. Void under uid 0, which ignores the mode bits.
  test.skipIf(process.getuid?.() === 0)('treats a dot-directory it cannot stat as not configured', () => {
    const blockedHome = path.join(fakeHome, 'blocked');
    fs.mkdirSync(path.join(blockedHome, '.claude'), { recursive: true });
    fs.chmodSync(blockedHome, 0o000);
    try {
      expect(findConfiguredAgents(KNOWN_AGENTS, blockedHome)).toEqual([]);
    } finally {
      // Restore before afterEach removes the temp home, or the rm fails too.
      fs.chmodSync(blockedHome, 0o700);
    }
  });

  test('returns multiple found agents in table order', () => {
    mkdir('.gemini');
    mkdir('.claude');
    expect(findConfiguredAgents(KNOWN_AGENTS, fakeHome).map((a) => a.name))
      .toEqual(['Claude Code', 'Gemini CLI']);
  });
});

describe('planDiscoveredAgentProfile', () => {
  const hostCapable = { name: 'Pi', host_mode_supported: true } as const;
  const hostModeUnsupported = { name: 'Claude Code', host_mode_supported: false } as const;

  test('offers the mode choice with no note for a host-capable agent without a warning', () => {
    expect(planDiscoveredAgentProfile({ agent: hostCapable, existingProfileNames: [] })).toEqual({
      mode: 'select',
      suggestedName: 'pi',
      hostModeNote: undefined,
    });
  });

  test("prefixes the agent's host-mode warning with 'Note: '", () => {
    const codex = {
      name: 'Codex',
      host_mode_supported: true,
      host_mode_warning:
        'Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    } as const;
    expect(planDiscoveredAgentProfile({ agent: codex, existingProfileNames: [] })).toEqual({
      mode: 'select',
      suggestedName: 'codex',
      hostModeNote:
        'Note: Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    });
  });

  // The note is agent-agnostic: a custom definition can set
  // host_mode_supported: false for reasons that have nothing to do with the
  // macOS Keychain, so the copy states the refusal, not a rationale.
  test('forces isolated with an explanatory note when host mode is unsupported', () => {
    expect(planDiscoveredAgentProfile({ agent: hostModeUnsupported, existingProfileNames: [] })).toEqual({
      mode: 'isolated',
      suggestedName: 'claude-code',
      isolatedOnlyNote:
        '  Claude Code does not support host mode. Creating as isolated\n' +
        '  agent profile.',
    });
  });

  test('names a custom agent in the same isolated-only note', () => {
    const plan = planDiscoveredAgentProfile({
      agent: { name: 'oh-my-pi', host_mode_supported: false },
      existingProfileNames: [],
    });
    expect(plan).toEqual({
      mode: 'isolated',
      suggestedName: 'oh-my-pi',
      isolatedOnlyNote:
        '  oh-my-pi does not support host mode. Creating as isolated\n' +
        '  agent profile.',
    });
  });

  test('suggests the unsuffixed default name when it is free', () => {
    const plan = planDiscoveredAgentProfile({ agent: hostModeUnsupported, existingProfileNames: [] });
    expect(plan.suggestedName).toBe('claude-code');
  });

  test('suggests -2 when the default name is taken', () => {
    const plan = planDiscoveredAgentProfile({
      agent: hostModeUnsupported,
      existingProfileNames: ['claude-code'],
    });
    expect(plan.suggestedName).toBe('claude-code-2');
  });

  test('counts past every taken suffix', () => {
    const plan = planDiscoveredAgentProfile({
      agent: hostModeUnsupported,
      existingProfileNames: ['claude-code', 'claude-code-2'],
    });
    expect(plan.suggestedName).toBe('claude-code-3');
  });

  test('ignores existing names unrelated to the agent', () => {
    const plan = planDiscoveredAgentProfile({
      agent: hostModeUnsupported,
      existingProfileNames: ['pi', 'codex-host', 'claude'],
    });
    expect(plan.suggestedName).toBe('claude-code');
  });
});

describe('agentProfileNameError', () => {
  test('rejects a whitespace-only name', () => {
    expect(agentProfileNameError({ value: '   ', existingProfileNames: [] })).toBe('Name is required');
  });

  test('rejects a path-unsafe name with the path-segment rule', () => {
    expect(agentProfileNameError({ value: '../x', existingProfileNames: [] })).toBe(
      "Names must not be '.' or '..', and must not contain '/' or '\\'.",
    );
  });

  test('rejects an existing name, naming the trimmed value', () => {
    expect(agentProfileNameError({ value: ' pi ', existingProfileNames: ['pi'] })).toBe(
      "Agent profile 'pi' already exists",
    );
  });

  test('accepts a fresh, path-safe name', () => {
    expect(agentProfileNameError({ value: 'pi-work', existingProfileNames: ['pi'] })).toBeUndefined();
  });
});
