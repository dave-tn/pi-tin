import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentProfileNameError,
  findConfiguredAgents,
  planDiscoveredAgentProfile,
} from './agent-discovery.js';

// findConfiguredAgents takes an explicit home in tests (os.homedir() may be
// cached, so $HOME overrides are unreliable) — the real home is never scanned.
let fakeHome: string;

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
    expect(findConfiguredAgents(fakeHome)).toEqual([]);
  });

  test('finds only the agent whose dot-directory exists', () => {
    mkdir('.claude');
    expect(findConfiguredAgents(fakeHome).map((a) => a.name)).toEqual(['Claude Code']);
  });

  test('ignores a dot-path that is a file rather than a directory', () => {
    fs.writeFileSync(path.join(fakeHome, '.claude'), 'not a directory');
    expect(findConfiguredAgents(fakeHome)).toEqual([]);
  });

  test('finds a multi-dot-dir agent when only one of its directories exists', () => {
    // OpenCode declares .local/share/opencode and .config/opencode; either
    // alone is enough signal (`some`, not `every`).
    mkdir('.config/opencode');
    expect(findConfiguredAgents(fakeHome).map((a) => a.name)).toEqual(['OpenCode']);
  });

  test('returns multiple found agents in KNOWN_AGENTS order', () => {
    mkdir('.gemini');
    mkdir('.claude');
    expect(findConfiguredAgents(fakeHome).map((a) => a.name)).toEqual(['Claude Code', 'Gemini CLI']);
  });
});

describe('planDiscoveredAgentProfile', () => {
  const hostCapable = { name: 'Pi', hostModeSupported: true } as const;
  const keychainOnly = { name: 'Claude Code', hostModeSupported: false } as const;

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
      hostModeSupported: true,
      hostModeWarning:
        'Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    } as const;
    expect(planDiscoveredAgentProfile({ agent: codex, existingProfileNames: [] })).toEqual({
      mode: 'select',
      suggestedName: 'codex',
      hostModeNote:
        'Note: Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    });
  });

  test('forces isolated with an explanatory note for a keychain-only agent', () => {
    expect(planDiscoveredAgentProfile({ agent: keychainOnly, existingProfileNames: [] })).toEqual({
      mode: 'isolated',
      suggestedName: 'claude-code',
      isolatedOnlyNote:
        "  Claude Code uses macOS Keychain for auth, which isn't available\n" +
        '  in containers. Creating as isolated agent profile.',
    });
  });

  test('suggests the unsuffixed default name when it is free', () => {
    const plan = planDiscoveredAgentProfile({ agent: keychainOnly, existingProfileNames: [] });
    expect(plan.suggestedName).toBe('claude-code');
  });

  test('suggests -2 when the default name is taken', () => {
    const plan = planDiscoveredAgentProfile({
      agent: keychainOnly,
      existingProfileNames: ['claude-code'],
    });
    expect(plan.suggestedName).toBe('claude-code-2');
  });

  test('counts past every taken suffix', () => {
    const plan = planDiscoveredAgentProfile({
      agent: keychainOnly,
      existingProfileNames: ['claude-code', 'claude-code-2'],
    });
    expect(plan.suggestedName).toBe('claude-code-3');
  });

  test('ignores existing names unrelated to the agent', () => {
    const plan = planDiscoveredAgentProfile({
      agent: keychainOnly,
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
