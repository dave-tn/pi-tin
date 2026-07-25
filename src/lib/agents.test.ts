import { describe, test, expect } from 'bun:test';
import { KNOWN_AGENTS, agentsWithSkipPermissions, agentContainerEnv, claudeConfigJson, claudeManagedSettingsJson, defaultProfileNameFor, nativeAgentInstalls, npmToolSpecs, toolDisplayName, toWorkspaceTool, workspaceHasClaudeCode } from './agents.js';
import { validateWorkspace } from './validators.js';
import type { Tool } from './validators.js';

describe('KNOWN_AGENTS', () => {
  test('every agent has a dotDirs field', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(Array.isArray(agent.dotDirs)).toBe(true);
      expect(agent.dotDirs.length).toBeGreaterThan(0);
      for (const d of agent.dotDirs) {
        expect(d.startsWith('.')).toBe(true);
      }
    }
  });

  test('dotDirs are unique across agents', () => {
    const allDirs = KNOWN_AGENTS.flatMap((a) => a.dotDirs);
    expect(new Set(allDirs).size).toBe(allDirs.length);
  });

  test('claude agent has .claude dotDir', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.dotDirs).toContain('.claude');
  });

  test('every agent has a binary field', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(typeof agent.binary).toBe('string');
      expect(agent.binary.length).toBeGreaterThan(0);
    }
  });

  test('agents with skip-permissions flags have the expected flags', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.skipPermissionsFlag).toBe('--dangerously-skip-permissions');

    const codex = KNOWN_AGENTS.find((a) => a.name === 'Codex');
    expect(codex?.skipPermissionsFlag).toBe('--dangerously-bypass-approvals-and-sandbox');

    const amp = KNOWN_AGENTS.find((a) => a.name === 'Amp');
    expect(amp?.skipPermissionsFlag).toBeUndefined();

    const gemini = KNOWN_AGENTS.find((a) => a.name === 'Gemini CLI');
    expect(gemini?.skipPermissionsFlag).toBe('--approval-mode=yolo');
  });

  test('agents with containerEnv have the expected env vars', () => {
    // No DISABLE_AUTOUPDATER: native-installed Claude Code keeps itself fresh
    // with its own auto-updater.
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.containerEnv).toEqual({ CLAUDE_CODE_SANDBOXED: '1' });

    const gemini = KNOWN_AGENTS.find((a) => a.name === 'Gemini CLI');
    expect(gemini?.containerEnv).toEqual({ NO_BROWSER: 'true' });

    const opencode = KNOWN_AGENTS.find((a) => a.name === 'OpenCode');
    expect(opencode?.containerEnv).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"permission":{"external_directory":"allow"}}',
    });
  });

  test('pi has no skip-permissions flag (always in skip mode)', () => {
    const pi = KNOWN_AGENTS.find((a) => a.name === 'Pi');
    expect(pi?.skipPermissionsFlag).toBeUndefined();
  });

  test('every agent has an install method; exactly Claude Code and OpenCode are native', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(['npm', 'native']).toContain(agent.install.method);
    }
    const nativeNames = KNOWN_AGENTS.filter((a) => a.install.method === 'native').map((a) => a.name);
    expect(nativeNames.sort()).toEqual(['Claude Code', 'OpenCode']);
  });

  test('Claude Code native install metadata is pinned', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.install).toEqual({
      method: 'native',
      installCommand:
        'curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh && rm /tmp/claude-install.sh',
      binDir: '.local/bin',
      stateEntries: [
        {
          path: '.local/share/claude',
          executable: false,
          launcher: { link: '.local/bin/claude', versionsDir: '.local/share/claude/versions' },
        },
      ],
      muslPackages: ['libgcc', 'libstdc++', 'ripgrep'],
      muslEnv: { USE_BUILTIN_RIPGREP: '0' },
    });
  });

  test('OpenCode native install metadata is pinned', () => {
    const opencode = KNOWN_AGENTS.find((a) => a.name === 'OpenCode');
    expect(opencode?.install).toEqual({
      method: 'native',
      installCommand:
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && bash /tmp/opencode-install.sh --no-modify-path && rm /tmp/opencode-install.sh',
      binDir: '.opencode/bin',
      stateEntries: [{ path: '.opencode/bin/opencode', executable: true }],
      muslPackages: [],
      muslEnv: {},
    });
  });
});

describe('install method helpers', () => {
  const mixed: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    { name: 'Codex', package: '@openai/codex@latest' },
    { name: 'OpenCode', package: 'opencode-ai@latest' },
    { name: 'custom', package: 'some-unknown-cli@latest' },
  ];

  test('nativeAgentInstalls returns native metadata in tool order', () => {
    expect(nativeAgentInstalls(mixed).map((install) => install.binDir))
      .toEqual(['.local/bin', '.opencode/bin']);
    expect(nativeAgentInstalls([])).toEqual([]);
  });

  test('npmToolSpecs keeps npm agents and unknown packages, excluding native agents', () => {
    expect(npmToolSpecs(mixed)).toEqual(['@openai/codex@latest', 'some-unknown-cli@latest']);
  });
});

describe('agentContainerEnv', () => {
  test('collects env vars for known agents', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Gemini CLI', package: '@google/gemini-cli@latest' },
    ];
    const env = agentContainerEnv(packages);
    expect(env).toEqual({ CLAUDE_CODE_SANDBOXED: '1', NO_BROWSER: 'true' });
  });

  test('includes the OpenCode external_directory sandbox config', () => {
    const packages: Tool[] = [
      { name: 'OpenCode', package: 'opencode-ai@latest' },
    ];
    expect(agentContainerEnv(packages)).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"permission":{"external_directory":"allow"}}',
    });
  });

  test('returns empty object for agents without containerEnv', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(agentContainerEnv(packages)).toEqual({});
  });

  test('does not match packages that only share a prefix with a known agent', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@anthropic-ai/claude-code-proxy@latest' },
    ];
    expect(agentContainerEnv(packages)).toEqual({});
  });
});

describe('agentsWithSkipPermissions', () => {
  test('returns wraps for known agents that still require wrapper flags', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const wraps = agentsWithSkipPermissions(packages);
    expect(wraps).toHaveLength(1);
    expect(wraps).toContainEqual({ binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' });
  });

  test('excludes agents without skip-permissions flag and agents configured via managed settings', () => {
    const packages: Tool[] = [
      { name: 'Pi', package: '@earendil-works/pi-coding-agent@latest' },
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    expect(agentsWithSkipPermissions(packages)).toEqual([]);
  });

  test('returns empty array for empty packages', () => {
    expect(agentsWithSkipPermissions([])).toEqual([]);
  });

  test('returns empty array for unknown packages', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: 'my-custom-agent@latest' },
    ];
    expect(agentsWithSkipPermissions(packages)).toEqual([]);
  });

  test('does not match packages that only share a prefix with a known agent', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@openai/codex-helper@latest' },
    ];
    expect(agentsWithSkipPermissions(packages)).toEqual([]);
  });
});

describe('workspaceHasClaudeCode', () => {
  test('returns true when Claude Code is installed', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    expect(workspaceHasClaudeCode(packages)).toBe(true);
  });

  test('returns false when Claude Code is not installed', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(workspaceHasClaudeCode(packages)).toBe(false);
  });

  test('does not match packages that only share a prefix with Claude Code', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@anthropic-ai/claude-code-proxy@latest' },
    ];
    expect(workspaceHasClaudeCode(packages)).toBe(false);
  });
});

describe('claudeManagedSettingsJson', () => {
  const claudeCode: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
  ];

  test('returns null when Claude Code is not installed', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(claudeManagedSettingsJson(packages, true)).toBeNull();
  });

  test('bypasses permissions and disables sandboxing when skip-permissions is on', () => {
    const settings = JSON.parse(claudeManagedSettingsJson(claudeCode, true)!);
    expect(settings).toEqual({
      permissions: { defaultMode: 'bypassPermissions' },
      sandbox: { enabled: false },
    });
  });

  test('returns null when skip-permissions is off so Claude Code defaults apply', () => {
    expect(claudeManagedSettingsJson(claudeCode, false)).toBeNull();
  });
});

describe('claudeConfigJson', () => {
  const claudeCode: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
  ];

  test('returns null when Claude Code is not installed', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(claudeConfigJson(packages, ['/workspace/pi-tin'])).toBeNull();
  });

  test('marks onboarding complete and each mounted project trusted', () => {
    const config = JSON.parse(claudeConfigJson(claudeCode, ['/workspace/pi-tin', '/workspace/other'])!);
    expect(config).toEqual({
      hasCompletedOnboarding: true,
      projects: {
        '/workspace/pi-tin': {
          hasTrustDialogAccepted: true,
          hasTrustDialogHooksAccepted: true,
          hasCompletedProjectOnboarding: true,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        },
        '/workspace/other': {
          hasTrustDialogAccepted: true,
          hasTrustDialogHooksAccepted: true,
          hasCompletedProjectOnboarding: true,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        },
      },
    });
  });

  test('seeds onboarding with an empty trust map when no projects are mounted', () => {
    const config = JSON.parse(claudeConfigJson(claudeCode, [])!);
    expect(config).toEqual({ hasCompletedOnboarding: true, projects: {} });
  });
});

describe('defaultProfileNameFor', () => {
  test('lowercases and hyphenates multi-word agent names', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code')!;
    expect(defaultProfileNameFor(claude)).toBe('claude-code');

    const gemini = KNOWN_AGENTS.find((a) => a.name === 'Gemini CLI')!;
    expect(defaultProfileNameFor(gemini)).toBe('gemini-cli');
  });

  test('leaves single-word agent names lowercased', () => {
    const codex = KNOWN_AGENTS.find((a) => a.name === 'Codex')!;
    expect(defaultProfileNameFor(codex)).toBe('codex');
  });
});

describe('toolDisplayName', () => {
  test('extracts name from scoped package with version', () => {
    expect(toolDisplayName('@anthropic-ai/claude-code@latest')).toBe('claude-code');
  });

  test('extracts name from scoped package without version', () => {
    expect(toolDisplayName('@playwright/cli')).toBe('cli');
  });

  test('extracts name from simple package with version', () => {
    expect(toolDisplayName('typescript@5.0.0')).toBe('typescript');
  });

  test('returns plain name unchanged', () => {
    expect(toolDisplayName('opencode')).toBe('opencode');
  });
});

describe('toWorkspaceTool', () => {
  test('projects an agent down to only name and package', () => {
    const claude = KNOWN_AGENTS.find((a) => a.binary === 'claude')!;
    expect(toWorkspaceTool(claude)).toEqual({
      name: claude.name,
      package: claude.package,
    });
  });

  test('output for every known agent validates against the strict tool schema', () => {
    // The persisted shape must round-trip through workspace validation, i.e.
    // contain no fields the strict ToolSchema rejects.
    const tools = KNOWN_AGENTS.map(toWorkspaceTool);
    expect(() =>
      validateWorkspace({ profile: 'default', projects: ['/tmp/x'], tools }),
    ).not.toThrow();
  });
});
