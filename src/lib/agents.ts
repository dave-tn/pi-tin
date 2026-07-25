import type { Tool } from './validators.js';

// Plain interface rather than a valibot schema: KNOWN_AGENTS is compile-time
// data that never crosses a parse boundary, so there is nothing to validate.
export interface KnownAgent {
  name: string;
  package: string;
  binary: string;
  dotDirs: string[];
  hostModeSupported: boolean;
  install: AgentInstall;
  hostModeWarning?: string;
  skipPermissionsFlag?: string;
  containerEnv?: Record<string, string>;
  /** Files written into a freshly created isolated agent-profile dir, path relative to the profile dir. */
  isolatedSeedFiles?: Array<{ path: string; content: string }>;
}

export interface NativeStateEntry {
  /**
   * Home-relative path persisted across container lives. Must never itself be
   * a symlink: `container cp` of a bare symlink as the source hangs and wedges
   * the container's exec channel (see docs/bug-fixing.md).
   */
  path: string;
  /** Re-apply +x after copy-in — `container cp` exec-bit preservation has varied across Apple container releases. */
  executable: boolean;
  /**
   * Launcher symlink the agent's updater manages around this entry. The bare
   * symlink cannot go through `container cp`, so pi-tin records its target at
   * copy-out, then recreates the link after copy-in and prunes `versionsDir`
   * to exactly that target (the updater keeps old versions forever, and a
   * copy-out taken mid-update can capture a truncated newer entry — the
   * recorded target is always a complete binary).
   */
  launcher?: { link: string; versionsDir: string };
}

/**
 * How an agent is installed and kept fresh. `npm` agents are baked with
 * `npm install -g` and refreshed into the shadow prefix on every open.
 * `native` agents run their official install script at image build, keep
 * themselves current in-container via their own auto-updater, and have the
 * updated binaries persisted across container lives via workspace state.
 */
export type AgentInstall = { method: 'npm' } | NativeAgentInstall;

export interface NativeAgentInstall {
  method: 'native';
  /** Shell command run as a Dockerfile RUN line in the user phase. */
  installCommand: string;
  /** Home-relative bin dir appended to the image PATH. */
  binDir: string;
  /** Home-relative paths persisted across container lives via workspace state. */
  stateEntries: NativeStateEntry[];
  /** Extra apk packages the binary needs on musl bases. */
  muslPackages: string[];
  /** Extra image ENV on musl bases. */
  muslEnv: Record<string, string>;
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

/** Native install metadata for the workspace's tools, in tool order. */
export function nativeAgentInstalls(packages: Tool[]): NativeAgentInstall[] {
  return packages.flatMap((pkg) => {
    const install = knownAgentForPackage(pkg)?.install;
    return install?.method === 'native' ? [install] : [];
  });
}

/** Package specs still installed and refreshed via npm (unknown packages stay npm). */
export function npmToolSpecs(packages: Tool[]): string[] {
  return packages
    .filter((pkg) => knownAgentForPackage(pkg)?.install.method !== 'native')
    .map((pkg) => pkg.package);
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
 * or null when the workspace doesn't include Claude Code or skip-permissions
 * mode is off. In skip-permissions mode the container is the sandbox, so
 * bypassPermissions is set and Claude Code's own sandbox is disabled;
 * otherwise no managed settings are baked and Claude Code's defaults apply.
 */
export function claudeManagedSettingsJson(packages: Tool[], skipPermissions: boolean): string | null {
  if (!workspaceHasClaudeCode(packages) || !skipPermissions) return null;
  return JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' },
    sandbox: {
      enabled: false,
    },
  }, null, 2);
}

/**
 * Build the `~/.claude.json` seeded into the container image, or null when the
 * workspace has no Claude Code. Marks first-run onboarding complete and fully
 * trusts each mounted project: `hasTrustDialogAccepted` lets Claude Code load
 * the repo's own `.claude/settings.json` (its `.mcp.json` MCP servers in
 * particular), and `hasTrustDialogHooksAccepted` lets its hooks run. Since
 * v2.1.53 (the CVE-2026-33068 fix) Claude Code gates these on workspace trust
 * regardless of permission mode — bypass-permissions does not cover them — and
 * trust can only be pre-granted per project path here; there is no env var or
 * managed-settings equivalent. `hasClaudeMdExternalIncludesApproved` (with its
 * warning-shown counterpart) pre-answers the dialog gating CLAUDE.md
 * `@`-imports that resolve outside the project directory — same per-project
 * persistence, no other pre-grant mechanism, and anything an import could
 * reach is already inside the container.
 */
export function claudeConfigJson(packages: Tool[], projectContainerPaths: string[]): string | null {
  if (!workspaceHasClaudeCode(packages)) return null;
  const projects = Object.fromEntries(
    projectContainerPaths.map((projectPath) => [
      projectPath,
      {
        hasTrustDialogAccepted: true,
        hasTrustDialogHooksAccepted: true,
        hasCompletedProjectOnboarding: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    ]),
  );
  return JSON.stringify({ hasCompletedOnboarding: true, projects }, null, 2);
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

// OpenCode is permissive by default (edit/bash → "allow") but still prompts on
// external_directory access. Inside a pi-tin workspace the container IS the
// boundary, so we flip that to "allow" and let the agent range across all
// mounted projects without prompting. Delivered via OPENCODE_CONFIG_CONTENT —
// inline JSON that OpenCode merges above the project's own opencode.json. The
// doom-loop runaway guard and .env-read denial are left at their defaults.
const OPENCODE_SANDBOX_CONFIG = JSON.stringify({ permission: { external_directory: 'allow' } });

// Pi gates loading of a project's own .pi config (settings, extensions,
// skills) behind a per-directory trust prompt, persisted in
// ~/.pi/agent/trust.json with nearest-ancestor matching — so one /workspace
// entry pre-trusts every mounted project; the container is the boundary.
// Seeded at isolated-profile creation only: an image-baked file would be
// shadowed by the .pi mount, and host-mode profiles share the real ~/.pi,
// where trust decisions stay the user's own.
const PI_TRUST_SEED = `${JSON.stringify({ '/workspace': true }, null, 2)}\n`;

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code@latest',
    binary: 'claude',
    dotDirs: ['.claude'],
    hostModeSupported: false,
    skipPermissionsFlag: '--dangerously-skip-permissions',
    containerEnv: { CLAUDE_CODE_SANDBOXED: '1' },
    // Native layout: ~/.local/bin/claude is a symlink into
    // ~/.local/share/claude/versions/<v>; the auto-updater swaps it atomically,
    // so freshness comes from the agent itself and the versions dir persists
    // across container lives. Only the versions tree is a state entry — the
    // launcher symlink rides the `launcher` metadata instead (bare-symlink cp
    // is forbidden).
    // Download-then-run, not `curl | bash`: a Dockerfile RUN has no pipefail,
    // so a piped curl failure would bake a "successful" image with no agent —
    // and buildHash would then pin that broken image until a manual --build.
    install: {
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
    },
  },
  {
    name: 'Pi',
    package: '@earendil-works/pi-coding-agent@latest',
    binary: 'pi',
    dotDirs: ['.pi'],
    hostModeSupported: true,
    install: { method: 'npm' },
    // Pi always runs in skip-permissions mode — no flag needed
    isolatedSeedFiles: [{ path: '.pi/agent/trust.json', content: PI_TRUST_SEED }],
  },
  {
    name: 'Codex',
    package: '@openai/codex@latest',
    binary: 'codex',
    dotDirs: ['.codex'],
    hostModeSupported: true,
    // Codex ships a native installer but no self-update mechanism, so the npm
    // refresh path stays its freshness story.
    install: { method: 'npm' },
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
    // Flat single binary; opencode replaces it by rename when it auto-updates
    // on startup. --no-modify-path: the image ENV PATH covers ~/.opencode/bin.
    // Download-then-run for the same no-pipefail reason as Claude above.
    install: {
      method: 'native',
      installCommand:
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && bash /tmp/opencode-install.sh --no-modify-path && rm /tmp/opencode-install.sh',
      binDir: '.opencode/bin',
      stateEntries: [{ path: '.opencode/bin/opencode', executable: true }],
      muslPackages: [],
      muslEnv: {},
    },
    // No skip-permissions flag needed (edit/bash default to "allow"); see
    // OPENCODE_SANDBOX_CONFIG above for the external_directory bypass.
    containerEnv: { OPENCODE_CONFIG_CONTENT: OPENCODE_SANDBOX_CONFIG },
  },
  {
    name: 'Amp',
    package: '@ampcode/cli@latest',
    binary: 'amp',
    dotDirs: ['.local/share/amp', '.config/amp'],
    hostModeSupported: true,
    install: { method: 'npm' },
    // Amp runs without approval prompts by default — no flag needed.
  },
  {
    name: 'Gemini CLI',
    package: '@google/gemini-cli@latest',
    binary: 'gemini',
    dotDirs: ['.gemini'],
    hostModeSupported: true,
    install: { method: 'npm' },
    skipPermissionsFlag: '--approval-mode=yolo',
    containerEnv: { NO_BROWSER: 'true' },
  },
];
