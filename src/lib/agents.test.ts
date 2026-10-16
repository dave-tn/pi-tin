import { describe, test, expect } from 'bun:test';
import { KNOWN_AGENTS, agentsWithSkipPermissions, agentContainerEnv, claudeConfigJson, claudeProfileSettingsPath, claudeUserSettingsJson, defaultProfileNameFor, planClaudeUserSettings, findBuiltInByName, findBuiltInByPackage, nativeInstallTargets, npmToolSpecs, packagesCollide, toolDisplayName, toWorkspaceTool, workspaceHasClaudeCode } from './agents.js';
import type { KnownAgent, NativeAgentInstall } from './agents.js';
import { validateWorkspace } from './validators.js';
import type { Tool } from './validators.js';

describe('KNOWN_AGENTS', () => {
  test('every agent has at least one dot-prefixed dotDir', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(agent.dot_dirs.length).toBeGreaterThan(0);
      for (const d of agent.dot_dirs) {
        expect(d.startsWith('.')).toBe(true);
      }
    }
  });

  test('dot_dirs are unique across agents', () => {
    const allDirs = KNOWN_AGENTS.flatMap((a) => a.dot_dirs);
    expect(new Set(allDirs).size).toBe(allDirs.length);
  });

  test('claude agent has .claude dotDir', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.dot_dirs).toContain('.claude');
  });

  test('every agent has a non-empty binary', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(agent.binary.length).toBeGreaterThan(0);
    }
  });

  test('agents with skip-permissions flags have the expected flags', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.skip_permissions_flag).toBe('--dangerously-skip-permissions');

    const codex = KNOWN_AGENTS.find((a) => a.name === 'Codex');
    expect(codex?.skip_permissions_flag).toBe('--dangerously-bypass-approvals-and-sandbox');

    const amp = KNOWN_AGENTS.find((a) => a.name === 'Amp');
    expect(amp?.skip_permissions_flag).toBeUndefined();

    const antigravity = KNOWN_AGENTS.find((a) => a.name === 'Antigravity');
    expect(antigravity?.skip_permissions_flag).toBe('--dangerously-skip-permissions');

    const copilot = KNOWN_AGENTS.find((a) => a.name === 'Copilot');
    expect(copilot?.skip_permissions_flag).toBe('--yolo');

    const crush = KNOWN_AGENTS.find((a) => a.name === 'Crush');
    expect(crush?.skip_permissions_flag).toBe('--yolo');
  });

  test('agents with container_env have the expected env vars', () => {
    // No DISABLE_AUTOUPDATER: native-installed Claude Code keeps itself fresh
    // with its own auto-updater.
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.container_env).toEqual({ CLAUDE_CODE_SANDBOXED: '1' });

    const opencode = KNOWN_AGENTS.find((a) => a.name === 'OpenCode');
    expect(opencode?.container_env).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"permission":{"external_directory":"allow"}}',
    });

    // No COPILOT_AUTO_UPDATE=false: native-installed Copilot keeps itself
    // fresh with its own updater, which swaps the binary on the live mount.
    const copilot = KNOWN_AGENTS.find((a) => a.name === 'Copilot');
    expect(copilot?.container_env).toEqual({});
  });

  test('Copilot api_key_vars are in token precedence order', () => {
    const copilot = KNOWN_AGENTS.find((a) => a.name === 'Copilot');
    expect(copilot?.api_key_vars).toEqual(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
  });

  test('pi has no skip-permissions flag (always in skip mode)', () => {
    const pi = KNOWN_AGENTS.find((a) => a.name === 'Pi');
    expect(pi?.skip_permissions_flag).toBeUndefined();
  });

  test('every agent has an install method; exactly Claude Code, OpenCode, Copilot and Antigravity are native', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(['npm', 'native']).toContain(agent.install.method);
    }
    const nativeNames = KNOWN_AGENTS.filter((a) => a.install.method === 'native').map((a) => a.name);
    expect(nativeNames.sort()).toEqual(['Antigravity', 'Claude Code', 'Copilot', 'OpenCode']);
  });

  test('Claude Code native install metadata is pinned', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code');
    expect(claude?.install).toEqual({
      method: 'native',
      install_command:
        'curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh && rm /tmp/claude-install.sh',
      installed_path: '.local/bin/claude',
      persist_dirs: ['.local/share/claude', '.local/bin'],
      bin_dir: '.local/bin',
      musl_packages: ['libgcc', 'libstdc++', 'ripgrep'],
      musl_env: { USE_BUILTIN_RIPGREP: '0' },
    });
  });

  test('OpenCode native install metadata is pinned', () => {
    const opencode = KNOWN_AGENTS.find((a) => a.name === 'OpenCode');
    expect(opencode?.install).toEqual({
      method: 'native',
      install_command:
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && bash /tmp/opencode-install.sh --no-modify-path && rm /tmp/opencode-install.sh',
      installed_path: '.opencode/bin/opencode',
      persist_dirs: ['.opencode/bin'],
      bin_dir: '.opencode/bin',
      musl_packages: [],
      musl_env: {},
    });
  });

  test('Copilot native install metadata is pinned', () => {
    const copilot = KNOWN_AGENTS.find((a) => a.name === 'Copilot');
    expect(copilot?.install).toEqual({
      method: 'native',
      install_command:
        'curl -fsSL https://gh.io/copilot-install -o /tmp/copilot-install.sh && PREFIX="$HOME/.local" bash /tmp/copilot-install.sh && rm /tmp/copilot-install.sh',
      installed_path: '.local/bin/copilot',
      persist_dirs: ['.local/bin', '.cache/copilot'],
      bin_dir: '.local/bin',
      musl_packages: [],
      musl_env: {},
    });
  });

  test('Antigravity native install metadata is pinned', () => {
    const antigravity = KNOWN_AGENTS.find((a) => a.name === 'Antigravity');
    expect(antigravity?.install).toEqual({
      method: 'native',
      install_command:
        'curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh && bash /tmp/agy-install.sh && rm /tmp/agy-install.sh',
      installed_path: '.local/bin/agy',
      persist_dirs: ['.local/bin'],
      bin_dir: '.local/bin',
      musl_packages: [],
      musl_env: {},
    });
  });

  // bin_dir joins the image PATH; persist_dirs become the live mounts. A bin_dir
  // outside persist_dirs would put the agent's own binary somewhere the mount
  // never persists — installed once, gone the next container life.
  test('every native agent mounts its bin_dir and installs inside a mounted dir', () => {
    for (const agent of KNOWN_AGENTS) {
      if (agent.install.method !== 'native') continue;
      const { bin_dir, persist_dirs, installed_path } = agent.install;
      expect(persist_dirs).toContain(bin_dir);
      expect(persist_dirs.some((dir) => installed_path.startsWith(`${dir}/`))).toBe(true);
    }
  });
});

describe('install method helpers', () => {
  const mixed: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    { name: 'Codex', package: '@openai/codex@latest' },
    { name: 'OpenCode', package: 'opencode-ai@latest' },
    { name: 'custom', package: 'some-unknown-cli@latest' },
  ];

  test('nativeInstallTargets pairs native metadata with agent identity, in tool order', () => {
    expect(nativeInstallTargets(mixed, KNOWN_AGENTS).map((target) => [target.name, target.binary, target.install.bin_dir]))
      .toEqual([
        ['Claude Code', 'claude', '.local/bin'],
        ['OpenCode', 'opencode', '.opencode/bin'],
      ]);
    expect(nativeInstallTargets([], KNOWN_AGENTS)).toEqual([]);
  });

  test('npmToolSpecs keeps npm agents and unknown packages, excluding native agents', () => {
    expect(npmToolSpecs(mixed, KNOWN_AGENTS)).toEqual(['@openai/codex@latest', 'some-unknown-cli@latest']);
  });
});

describe('agentContainerEnv', () => {
  test('collects env vars for known agents', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Copilot', package: '@github/copilot@latest' },
    ];
    const env = agentContainerEnv(packages, KNOWN_AGENTS);
    expect(env).toEqual({ CLAUDE_CODE_SANDBOXED: '1' });
  });

  test('includes the OpenCode external_directory sandbox config', () => {
    const packages: Tool[] = [
      { name: 'OpenCode', package: 'opencode-ai@latest' },
    ];
    expect(agentContainerEnv(packages, KNOWN_AGENTS)).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"permission":{"external_directory":"allow"}}',
    });
  });

  test('returns empty object for agents with an empty container_env', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(agentContainerEnv(packages, KNOWN_AGENTS)).toEqual({});
  });

  test('does not match packages that only share a prefix with a known agent', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@anthropic-ai/claude-code-proxy@latest' },
    ];
    expect(agentContainerEnv(packages, KNOWN_AGENTS)).toEqual({});
  });
});

describe('agentsWithSkipPermissions', () => {
  test('returns wraps for known agents that still require wrapper flags', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const wraps = agentsWithSkipPermissions(packages, KNOWN_AGENTS);
    expect(wraps).toHaveLength(1);
    expect(wraps).toContainEqual({ binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' });
  });

  test('excludes agents without skip-permissions flag and Claude Code, which takes bypass from its settings', () => {
    const packages: Tool[] = [
      { name: 'Pi', package: '@earendil-works/pi-coding-agent@latest' },
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    expect(agentsWithSkipPermissions(packages, KNOWN_AGENTS)).toEqual([]);
  });

  test('returns empty array for empty packages', () => {
    expect(agentsWithSkipPermissions([], KNOWN_AGENTS)).toEqual([]);
  });

  test('returns empty array for unknown packages', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: 'my-custom-agent@latest' },
    ];
    expect(agentsWithSkipPermissions(packages, KNOWN_AGENTS)).toEqual([]);
  });

  test('does not match packages that only share a prefix with a known agent', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@openai/codex-helper@latest' },
    ];
    expect(agentsWithSkipPermissions(packages, KNOWN_AGENTS)).toEqual([]);
  });
});

describe('workspaceHasClaudeCode', () => {
  test('returns true when Claude Code is installed', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    expect(workspaceHasClaudeCode(packages, KNOWN_AGENTS)).toBe(true);
  });

  test('returns false when Claude Code is not installed', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(workspaceHasClaudeCode(packages, KNOWN_AGENTS)).toBe(false);
  });

  test('does not match packages that only share a prefix with Claude Code', () => {
    const packages: Tool[] = [
      { name: 'Custom', package: '@anthropic-ai/claude-code-proxy@latest' },
    ];
    expect(workspaceHasClaudeCode(packages, KNOWN_AGENTS)).toBe(false);
  });
});

describe('claudeUserSettingsJson', () => {
  const claudeCode: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
  ];

  test('returns null when Claude Code is not installed', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    expect(claudeUserSettingsJson(packages, true, KNOWN_AGENTS)).toBeNull();
  });

  test('bypasses permissions, disables sandboxing and pre-accepts the bypass warning when skip-permissions is on', () => {
    const settings = JSON.parse(claudeUserSettingsJson(claudeCode, true, KNOWN_AGENTS)!);
    expect(settings).toEqual({
      permissions: { defaultMode: 'bypassPermissions' },
      sandbox: { enabled: false },
      skipDangerousModePermissionPrompt: true,
    });
  });

  test('returns null when skip-permissions is off so Claude Code defaults apply', () => {
    expect(claudeUserSettingsJson(claudeCode, false, KNOWN_AGENTS)).toBeNull();
  });
});

describe('planClaudeUserSettings', () => {
  test('writes the bypass settings when the agent profile has no settings file yet', () => {
    expect(planClaudeUserSettings(null)).toEqual({
      action: 'write',
      content: '{\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  },\n  "sandbox": {\n    "enabled": false\n  },\n  "skipDangerousModePermissionPrompt": true\n}\n',
    });
  });

  test('merges into existing settings, keeping unrelated keys and sibling permission and sandbox keys', () => {
    const existing = JSON.stringify({
      hooks: { SessionStart: [] },
      permissions: { allow: ['Bash(bun test:*)'], defaultMode: 'auto' },
      sandbox: { excludedCommands: ['docker'] },
      theme: 'dark',
    });
    const plan = planClaudeUserSettings(existing);
    expect(plan.action).toBe('write');
    if (plan.action !== 'write') return;
    expect(JSON.parse(plan.content)).toEqual({
      hooks: { SessionStart: [] },
      permissions: { allow: ['Bash(bun test:*)'], defaultMode: 'bypassPermissions' },
      sandbox: { excludedCommands: ['docker'], enabled: false },
      theme: 'dark',
      skipDangerousModePermissionPrompt: true,
    });
  });

  test('leaves the file alone when the bypass settings are already in place', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      permissions: { defaultMode: 'bypassPermissions', allow: [] },
      sandbox: { enabled: false },
      skipDangerousModePermissionPrompt: true,
    }, null, 4);
    expect(planClaudeUserSettings(existing)).toEqual({ action: 'unchanged' });
  });

  test('rewrites settings that hold only some of the bypass keys', () => {
    const existing = JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
      sandbox: { enabled: false },
    });
    const plan = planClaudeUserSettings(existing);
    expect(plan.action).toBe('write');
    if (plan.action !== 'write') return;
    expect(JSON.parse(plan.content).skipDangerousModePermissionPrompt).toBe(true);
  });

  test('refuses a file that is not valid JSON, passing through the parser message', () => {
    const content = '{ "theme": "dark", }';
    // The runtime owns JSON syntax messages (they differ between engines), so
    // the expectation is the runtime's own message for the same input.
    const syntaxMessage = (() => {
      try {
        JSON.parse(content);
        return 'parsed';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(planClaudeUserSettings(content)).toEqual({ action: 'invalid', reason: syntaxMessage });
  });

  test('refuses settings whose shape it would have to overwrite, naming the field', () => {
    expect(planClaudeUserSettings('[]')).toEqual({
      action: 'invalid',
      reason: 'Invalid Claude Code settings configuration:\n  Expected an object, not an array',
    });
    expect(planClaudeUserSettings('{ "permissions": [] }')).toEqual({
      action: 'invalid',
      reason: 'Invalid Claude Code settings configuration:\n  permissions: Expected an object, not an array',
    });
    expect(planClaudeUserSettings('{ "permissions": "allow-all" }')).toEqual({
      action: 'invalid',
      reason: 'Invalid Claude Code settings configuration:\n  permissions: Invalid type: Expected Object but received "allow-all"',
    });
    expect(planClaudeUserSettings('{ "sandbox": true }')).toEqual({
      action: 'invalid',
      reason: 'Invalid Claude Code settings configuration:\n  sandbox: Invalid type: Expected Object but received true',
    });
  });
});

describe('claudeProfileSettingsPath', () => {
  const claudeCode: Tool[] = [
    { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
  ];
  const isolatedClaude = { name: 'work', mount: '.claude', hostPath: '/profiles/work/.claude', mode: 'isolated' as const };
  const isolatedPi = { name: 'pi', mount: '.pi', hostPath: '/profiles/pi/.pi', mode: 'isolated' as const };

  test('targets the settings.json of the isolated agent profile mounted at ~/.claude', () => {
    expect(claudeProfileSettingsPath({
      packages: claudeCode,
      skipPermissions: true,
      agents: KNOWN_AGENTS,
      agentProfileMounts: [isolatedPi, isolatedClaude],
    })).toBe('/profiles/work/.claude/settings.json');
  });

  test('never targets a host-mode agent profile, which is the real host config', () => {
    expect(claudeProfileSettingsPath({
      packages: claudeCode,
      skipPermissions: true,
      agents: KNOWN_AGENTS,
      agentProfileMounts: [{ ...isolatedClaude, hostPath: '/Users/me/.claude', mode: 'host' }],
    })).toBeNull();
  });

  test('targets nothing without a Claude agent profile, leaving the baked file to apply', () => {
    expect(claudeProfileSettingsPath({
      packages: claudeCode,
      skipPermissions: true,
      agents: KNOWN_AGENTS,
      agentProfileMounts: [isolatedPi],
    })).toBeNull();
  });

  test('targets nothing when skip-permissions is off', () => {
    expect(claudeProfileSettingsPath({
      packages: claudeCode,
      skipPermissions: false,
      agents: KNOWN_AGENTS,
      agentProfileMounts: [isolatedClaude],
    })).toBeNull();
  });

  test('targets nothing when the workspace does not include Claude Code', () => {
    expect(claudeProfileSettingsPath({
      packages: [{ name: 'Codex', package: '@openai/codex@latest' }],
      skipPermissions: true,
      agents: KNOWN_AGENTS,
      agentProfileMounts: [isolatedClaude],
    })).toBeNull();
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
    expect(claudeConfigJson(packages, ['/workspace/pi-tin'], KNOWN_AGENTS)).toBeNull();
  });

  test('marks onboarding complete and each mounted project trusted', () => {
    const config = JSON.parse(claudeConfigJson(claudeCode, ['/workspace/pi-tin', '/workspace/other'], KNOWN_AGENTS)!);
    expect(config).toEqual({
      hasCompletedOnboarding: true,
      hasSeenAutoDefaultNudge: true,
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
    const config = JSON.parse(claudeConfigJson(claudeCode, [], KNOWN_AGENTS)!);
    expect(config).toEqual({ hasCompletedOnboarding: true, hasSeenAutoDefaultNudge: true, projects: {} });
  });
});

describe('defaultProfileNameFor', () => {
  test('lowercases and hyphenates multi-word agent names', () => {
    const claude = KNOWN_AGENTS.find((a) => a.name === 'Claude Code')!;
    expect(defaultProfileNameFor(claude)).toBe('claude-code');

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

// The helpers take the table they search, so an entry that is not built in is
// found on exactly the same terms as one that is.
describe('lookup helpers over an extended agents table', () => {
  const CUSTOM: KnownAgent = {
    name: 'Oh My Pi',
    package: 'oh-my-pi@latest',
    binary: 'omp',
    dot_dirs: ['.oh-my-pi'],
    host_mode_supported: true,
    install: { method: 'npm' },
    skip_permissions_flag: '--yolo',
    container_env: { OMP_LOG: 'info' },
    api_key_vars: [],
    isolated_seed_files: [],
  };

  const CUSTOM_NATIVE_INSTALL: NativeAgentInstall = {
    method: 'native',
    install_command: 'curl -fsSL https://example.invalid/install -o /tmp/z.sh && bash /tmp/z.sh',
    installed_path: '.zed-agent/bin/zedagent',
    persist_dirs: ['.zed-agent/bin'],
    bin_dir: '.zed-agent/bin',
    musl_packages: [],
    musl_env: {},
  };

  const CUSTOM_NATIVE: KnownAgent = {
    name: 'Zed Agent',
    package: 'zed-agent@latest',
    binary: 'zedagent',
    dot_dirs: ['.zed-agent'],
    host_mode_supported: true,
    install: CUSTOM_NATIVE_INSTALL,
    container_env: {},
    api_key_vars: [],
    isolated_seed_files: [],
  };

  const TABLE = [...KNOWN_AGENTS, CUSTOM, CUSTOM_NATIVE];
  const ompTool: Tool = { name: 'Oh My Pi', package: 'oh-my-pi@latest' };
  const zedTool: Tool = { name: 'Zed Agent', package: 'zed-agent@latest' };
  const claudeTool: Tool = { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' };

  test('npmToolSpecs keeps an npm custom entry', () => {
    expect(npmToolSpecs([ompTool], TABLE)).toEqual(['oh-my-pi@latest']);
  });

  test('npmToolSpecs excludes a native custom entry only when the table carries it', () => {
    expect(npmToolSpecs([zedTool], TABLE)).toEqual([]);
    expect(npmToolSpecs([zedTool], KNOWN_AGENTS)).toEqual(['zed-agent@latest']);
  });

  test('nativeInstallTargets picks up a native custom entry', () => {
    expect(nativeInstallTargets([zedTool], TABLE)).toEqual([
      { name: 'Zed Agent', binary: 'zedagent', install: CUSTOM_NATIVE_INSTALL },
    ]);
    expect(nativeInstallTargets([zedTool], KNOWN_AGENTS)).toEqual([]);
  });

  test('agentsWithSkipPermissions wraps a custom entry with a flag', () => {
    expect(agentsWithSkipPermissions([ompTool], TABLE)).toEqual([
      { binary: 'omp', flag: '--yolo' },
    ]);
    expect(agentsWithSkipPermissions([ompTool], KNOWN_AGENTS)).toEqual([]);
  });

  test('agentContainerEnv merges a custom entry env alongside a built-in', () => {
    expect(agentContainerEnv([claudeTool, ompTool], TABLE)).toEqual({
      CLAUDE_CODE_SANDBOXED: '1',
      OMP_LOG: 'info',
    });
  });
});

// `binary` is free user input in a definition file, so it cannot identify
// Claude Code. A fork declaring `binary: claude` must keep its own flag and get
// none of Claude Code's baked config — the loader only reserves name and package.
describe('a custom agent that declares binary: claude', () => {
  const fork: KnownAgent = {
    name: 'Claude Fork',
    package: 'claude-code-fork@latest',
    binary: 'claude',
    dot_dirs: ['.claude-fork'],
    host_mode_supported: true,
    install: { method: 'npm' },
    skip_permissions_flag: '--yolo',
    container_env: {},
    api_key_vars: [],
    isolated_seed_files: [],
  };
  const table = [...KNOWN_AGENTS, fork];
  const forkTool: Tool = { name: 'Claude Fork', package: 'claude-code-fork@latest' };

  test('keeps its own skip-permissions flag rather than routing to Claude Code settings', () => {
    expect(agentsWithSkipPermissions([forkTool], table)).toEqual([
      { binary: 'claude', flag: '--yolo' },
    ]);
  });

  test('does not make the workspace count as having Claude Code', () => {
    expect(workspaceHasClaudeCode([forkTool], table)).toBe(false);
    expect(claudeUserSettingsJson([forkTool], true, table)).toBeNull();
    expect(claudeConfigJson([forkTool], ['/workspace/pi-tin'], table)).toBeNull();
  });
});

describe('findBuiltInByName', () => {
  test('matches a built-in name case-insensitively', () => {
    expect(findBuiltInByName('claude code')?.name).toBe('Claude Code');
    expect(findBuiltInByName('Claude Code')?.name).toBe('Claude Code');
    expect(findBuiltInByName('ANTIGRAVITY')?.name).toBe('Antigravity');
  });

  test('does not match on a partial name', () => {
    expect(findBuiltInByName('claude')).toBeUndefined();
  });

  test('never matches a name that is not built in', () => {
    expect(findBuiltInByName('Oh My Pi')).toBeUndefined();
  });
});

describe('findBuiltInByPackage', () => {
  test('matches a built-in package regardless of version suffix', () => {
    expect(findBuiltInByPackage('@anthropic-ai/claude-code@1.2.3')?.name).toBe('Claude Code');
    expect(findBuiltInByPackage('@anthropic-ai/claude-code')?.name).toBe('Claude Code');
    expect(findBuiltInByPackage('opencode-ai@latest')?.name).toBe('OpenCode');
  });

  test('does not match a package that only shares a prefix', () => {
    expect(findBuiltInByPackage('@anthropic-ai/claude-code-proxy@latest')).toBeUndefined();
  });

  test('never matches a package that is not built in', () => {
    expect(findBuiltInByPackage('oh-my-pi@latest')).toBeUndefined();
  });
});

describe('packagesCollide', () => {
  test('two specs of the same package collide across versions and case', () => {
    expect(packagesCollide('oh-my-pi@latest', 'oh-my-pi@1.0.0')).toBe(true);
    expect(packagesCollide('oh-my-pi', 'oh-my-pi@2.3.4')).toBe(true);
    expect(packagesCollide('OH-MY-PI@latest', 'oh-my-pi@1.0.0')).toBe(true);
    expect(packagesCollide('@scope/tool@latest', '@scope/tool@0.1.0')).toBe(true);
  });

  test('different packages do not collide, prefix overlap included', () => {
    expect(packagesCollide('oh-my-pi@latest', 'oh-my-pi-extras@latest')).toBe(false);
    expect(packagesCollide('@scope/tool@latest', 'tool@latest')).toBe(false);
  });
});
