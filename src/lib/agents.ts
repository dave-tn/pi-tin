import type { Tool } from './validators.js';

// Plain interface rather than a valibot schema: KNOWN_AGENTS is compile-time
// data that never crosses a parse boundary, so there is nothing to validate.
export interface KnownAgent {
  name: string;
  package: string;
  binary: string;
  dotDirs: string[];
  hostModeSupported: boolean;
  hostModeWarning?: string;
  skipPermissionsFlag?: string;
  containerEnv?: Record<string, string>;
}

function packageName(packageSpec: string): string {
  return packageSpec.replace(/@[^/@]*$/, '');
}

export function toolDisplayName(packageSpec: string): string {
  const parts = packageName(packageSpec).split('/');
  return parts[parts.length - 1] ?? packageSpec;
}

function packageMatchesAgent(packageSpec: string, agent: KnownAgent): boolean {
  return packageName(packageSpec) === packageName(agent.package);
}

function knownAgentForPackage(pkg: Tool): KnownAgent | undefined {
  return KNOWN_AGENTS.find((agent) => packageMatchesAgent(pkg.package, agent));
}

/**
 * Project a KNOWN_AGENTS entry down to the public Tool shape persisted in a
 * workspace YAML. Internal fields (binary, skipPermissionsFlag, containerEnv,
 * dotDirs, hostMode*) are re-derived from `package` at runtime, so we never
 * write them to disk — only `name` and `package` identify the tool.
 */
export function toWorkspaceTool(agent: KnownAgent): Tool {
  return { name: agent.name, package: agent.package };
}

/** Default agent-profile name derived from the agent's display name. */
export function defaultProfileNameFor(agent: Pick<KnownAgent, 'name'>): string {
  return agent.name.toLowerCase().replace(/\s+/g, '-');
}

function usesManagedSkipPermissions(agent: KnownAgent): boolean {
  return agent.binary === 'claude';
}

/** Return whether the workspace includes Claude Code. */
export function workspaceHasClaudeCode(packages: Tool[]): boolean {
  return packages.some((pkg) => knownAgentForPackage(pkg)?.binary === 'claude');
}

/**
 * Build the Claude Code managed-settings JSON baked into the container image,
 * or null when the workspace doesn't include Claude Code. Sandboxing is always
 * disabled — the container is the sandbox — while bypassPermissions is only
 * set when skip-permissions mode is enabled.
 */
export function claudeManagedSettingsJson(packages: Tool[], skipPermissions: boolean): string | null {
  if (!workspaceHasClaudeCode(packages)) return null;
  return JSON.stringify({
    ...(skipPermissions ? { permissions: { defaultMode: 'bypassPermissions' } } : {}),
    sandbox: {
      enabled: false,
    },
  }, null, 2);
}

/** Return container env vars needed by the workspace's agents. */
export function agentContainerEnv(packages: Tool[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pkg of packages) {
    const agent = knownAgentForPackage(pkg);
    if (agent?.containerEnv) {
      Object.assign(env, agent.containerEnv);
    }
  }
  return env;
}

/** Return the agents that still require launcher wrapping to enable skip-permissions mode. */
export function agentsWithSkipPermissions(packages: Tool[]): Array<{ binary: string; flag: string }> {
  const results: Array<{ binary: string; flag: string }> = [];
  for (const pkg of packages) {
    const agent = knownAgentForPackage(pkg);
    if (agent?.skipPermissionsFlag && !usesManagedSkipPermissions(agent)) {
      results.push({ binary: agent.binary, flag: agent.skipPermissionsFlag });
    }
  }
  return results;
}

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code@latest',
    binary: 'claude',
    dotDirs: ['.claude'],
    hostModeSupported: false,
    skipPermissionsFlag: '--dangerously-skip-permissions',
    containerEnv: { CLAUDE_CODE_SANDBOXED: '1' },
  },
  {
    name: 'Pi',
    package: '@earendil-works/pi-coding-agent@latest',
    binary: 'pi',
    dotDirs: ['.pi'],
    hostModeSupported: true,
    // Pi always runs in skip-permissions mode — no flag needed
  },
  {
    name: 'Codex',
    package: '@openai/codex@latest',
    binary: 'codex',
    dotDirs: ['.codex'],
    hostModeSupported: true,
    hostModeWarning:
      'Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    skipPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
  },
  {
    name: 'OpenCode',
    package: 'opencode-ai@latest',
    binary: 'opencode',
    dotDirs: ['.local/share/opencode', '.config/opencode'],
    hostModeSupported: true,
  },
  {
    name: 'Amp',
    package: '@ampcode/cli@latest',
    binary: 'amp',
    dotDirs: ['.local/share/amp', '.config/amp'],
    hostModeSupported: true,
    // Amp runs without approval prompts by default — no flag needed.
  },
  {
    name: 'Gemini CLI',
    package: '@google/gemini-cli@latest',
    binary: 'gemini',
    dotDirs: ['.gemini'],
    hostModeSupported: true,
    skipPermissionsFlag: '--approval-mode=yolo',
    containerEnv: { NO_BROWSER: 'true' },
  },
];
