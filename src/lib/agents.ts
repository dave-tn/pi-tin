import path from 'node:path';
import { errorMessage } from './guards.js';
import { validateClaudeUserSettings, type AgentDefinitionFile, type ClaudeUserSettings, type Tool } from './validators.js';
import type { ResolvedAgentProfileMount } from './agent-profiles.js';

/**
 * A built-in agent: the agent-definition shape, plus the identity a definition
 * file leaves implicit (there the file name is the agent name). One type for
 * both sources, so a built-in entry and a user-authored definition are
 * interchangeable everywhere downstream. `isolated_seed_files` are written into
 * a freshly created isolated agent-profile dir, path relative to that dir.
 */
export type KnownAgent = AgentDefinitionFile & { name: string };

/**
 * How an agent is installed and kept fresh. `npm` agents are baked with
 * `npm install -g` and refreshed into the shadow prefix on every open.
 * `native` agents run their official install script in-container at first
 * open, onto live host mounts (`persist_dirs`) backed by the workspace-state
 * dir — so their own auto-updaters keep them current and every update
 * persists across container lives, exactly as on a plain host.
 *
 * Its fields: `install_command` is the shell command run in-container (under
 * the host-side install lock) when `installed_path` probes absent.
 * `installed_path` is a home-relative path checked in-container with `test -x`
 * — for Claude the launcher symlink, so a dangling link or non-executable
 * target reads as "not installed" and self-heals via reinstall. `persist_dirs`
 * are the home-relative dirs live-mounted from the workspace-state dir.
 * `bin_dir` is the home-relative bin dir appended to the image PATH; it
 * duplicates an element of `persist_dirs` deliberately, and the invariant is
 * tested. `musl_packages` and `musl_env` are the extra apk packages and image
 * ENV the binary needs on musl bases.
 */
export type NativeAgentInstall = Extract<KnownAgent['install'], { method: 'native' }>;

function packageName(packageSpec: string): string {
  return packageSpec.replace(/@[^/@]*$/, '');
}

/**
 * Whether two package specs name the same package, ignoring the version suffix
 * and case. The single home of that comparison: agent definitions and the
 * delete planner need it too, and the version strip must not be duplicated.
 */
export function packagesCollide(a: string, b: string): boolean {
  return packageName(a).toLowerCase() === packageName(b).toLowerCase();
}

export function toolDisplayName(packageSpec: string): string {
  const parts = packageName(packageSpec).split('/');
  return parts[parts.length - 1] ?? packageSpec;
}

function packageMatchesAgent(packageSpec: string, agent: KnownAgent): boolean {
  return packagesCollide(packageSpec, agent.package);
}

function knownAgentForPackage(pkg: Tool, agents: readonly KnownAgent[]): KnownAgent | undefined {
  return agents.find((agent) => packageMatchesAgent(pkg.package, agent));
}

/**
 * Find a built-in agent by display name, case-insensitively. Searches
 * KNOWN_AGENTS only, never a caller-supplied table: this answers "is this one
 * of ours?", a question a merged built-in-plus-custom table cannot answer.
 */
export function findBuiltInByName(name: string): KnownAgent | undefined {
  return KNOWN_AGENTS.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
}

/** As findBuiltInByName, but keyed on package spec with the version suffix ignored. */
export function findBuiltInByPackage(packageSpec: string): KnownAgent | undefined {
  return KNOWN_AGENTS.find((agent) => packageMatchesAgent(packageSpec, agent));
}

/**
 * Project a KNOWN_AGENTS entry down to the public Tool shape persisted in a
 * workspace YAML. Internal fields (binary, skip_permissions_flag,
 * container_env, dot_dirs, host_mode_*) are re-derived from `package` at
 * runtime, so we never write them to disk — only `name` and `package`
 * identify the tool.
 */
export function toWorkspaceTool(agent: KnownAgent): Tool {
  return { name: agent.name, package: agent.package };
}

/** Default agent-profile name derived from the agent's display name. */
export function defaultProfileNameFor(agent: Pick<KnownAgent, 'name'>): string {
  return agent.name.toLowerCase().replace(/\s+/g, '-');
}

/** Human-readable list of an agent's host config directories, tilde-relative. */
export function dotDirsLabel(agent: Pick<KnownAgent, 'dot_dirs'>): string {
  return agent.dot_dirs.map((dir) => `~/${dir}`).join(', ');
}

/**
 * A native-install agent paired with its identity: the install step names
 * what it installs (progress line, lock key), and `NativeAgentInstall`
 * deliberately carries no identity fields of its own — `KnownAgent` does.
 * `binary` is the lock key (unique and filesystem-safe); `name` is display.
 */
export type NativeInstallTarget = Pick<KnownAgent, 'name' | 'binary'> & {
  install: NativeAgentInstall;
};

/** Native-install agents among the workspace's tools, in tool order. */
export function nativeInstallTargets(
  packages: Tool[],
  agents: readonly KnownAgent[],
): NativeInstallTarget[] {
  return packages.flatMap((pkg): NativeInstallTarget[] => {
    const agent = knownAgentForPackage(pkg, agents);
    return agent !== undefined && agent.install.method === 'native'
      ? [{ name: agent.name, binary: agent.binary, install: agent.install }]
      : [];
  });
}

/** Package specs still installed and refreshed via npm (unknown packages stay npm). */
export function npmToolSpecs(packages: Tool[], agents: readonly KnownAgent[]): string[] {
  return packages
    .filter((pkg) => knownAgentForPackage(pkg, agents)?.install.method !== 'native')
    .map((pkg) => pkg.package);
}

// Claude Code is identified by `package`, never by `binary`: a user definition
// supplies its own binary name, so a fork declaring `binary: claude` would
// otherwise lose its declared skip-permissions flag and inherit Claude Code's
// baked config. Package is the identity axis the loader reserves.
function isBuiltInClaudeCode(agent: KnownAgent): boolean {
  return findBuiltInByPackage(agent.package)?.binary === 'claude';
}

/** Return whether the workspace includes Claude Code. */
export function workspaceHasClaudeCode(packages: Tool[], agents: readonly KnownAgent[]): boolean {
  return packages.some((pkg) => {
    const agent = knownAgentForPackage(pkg, agents);
    return agent !== undefined && isBuiltInClaudeCode(agent);
  });
}

/**
 * Build the Claude Code user settings (`~/.claude/settings.json`) baked into
 * the container image, or null when the workspace doesn't include Claude Code
 * or skip-permissions mode is off. In skip-permissions mode the container is
 * the sandbox, so bypassPermissions is set and Claude Code's own sandbox is
 * disabled. An agent profile mounted at ~/.claude shadows this file; its own
 * settings get the same keys merged in at open (planClaudeUserSettings).
 *
 * User settings, not managed settings: Claude Code reads a single managed
 * source, and an organisation's server-managed settings outrank (and skip)
 * any file-based ones, so a baked managed-settings drop-in silently stops
 * applying for anyone whose org pushes remote settings. User settings are one
 * of the sources Claude Code allows to grant bypass mode — but the lowest-
 * precedence one, so a project's own `.claude/settings.json` or
 * `settings.local.json` that sets `permissions.defaultMode` or
 * `sandbox.enabled` wins.
 */
export function claudeUserSettingsJson(
  packages: Tool[],
  skipPermissions: boolean,
  agents: readonly KnownAgent[],
): string | null {
  if (!workspaceHasClaudeCode(packages, agents) || !skipPermissions) return null;
  return JSON.stringify(withClaudeBypass({}), null, 2);
}

/**
 * The host path of the `settings.json` pi-tin merges its bypass keys into, or
 * null when there is none to write: skip-permissions off, no Claude Code, or
 * no isolated agent profile mounted at ~/.claude (the image-baked file then
 * applies). A host-mode agent profile is the user's real config and is never
 * written.
 */
export function claudeProfileSettingsPath(input: {
  packages: Tool[];
  skipPermissions: boolean;
  agents: readonly KnownAgent[];
  agentProfileMounts: readonly ResolvedAgentProfileMount[];
}): string | null {
  if (!input.skipPermissions || !workspaceHasClaudeCode(input.packages, input.agents)) return null;
  const claudeProfileMount = input.agentProfileMounts.find(
    (profileMount) => profileMount.mount === CLAUDE_DOT_DIR && profileMount.mode === 'isolated',
  );
  return claudeProfileMount === undefined ? null : path.join(claudeProfileMount.hostPath, 'settings.json');
}

export type ClaudeUserSettingsPlan =
  | { action: 'write'; content: string }
  | { action: 'unchanged' }
  | { action: 'invalid'; reason: string };

/**
 * Plan the merge of pi-tin's bypass keys into an agent profile's existing
 * `settings.json` (null when the file doesn't exist). Only those keys are
 * set — every other setting, including sibling permission rules, is kept.
 * A file that isn't valid JSON, or whose `permissions`/`sandbox` isn't an
 * object, is left untouched rather than overwritten.
 */
export function planClaudeUserSettings(existingContent: string | null): ClaudeUserSettingsPlan {
  const parsed = existingContent === null
    ? { ok: true as const, settings: {} }
    : parseClaudeUserSettings(existingContent);
  if (!parsed.ok) return { action: 'invalid', reason: parsed.reason };
  const merged = withClaudeBypass(parsed.settings);
  return JSON.stringify(merged) === JSON.stringify(parsed.settings)
    ? { action: 'unchanged' }
    : { action: 'write', content: `${JSON.stringify(merged, null, 2)}\n` };
}

function parseClaudeUserSettings(
  content: string,
): { ok: true; settings: ClaudeUserSettings } | { ok: false; reason: string } {
  try {
    return { ok: true, settings: validateClaudeUserSettings(JSON.parse(content)) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function withClaudeBypass(settings: ClaudeUserSettings): ClaudeUserSettings {
  return {
    ...settings,
    permissions: { ...settings.permissions, defaultMode: 'bypassPermissions' },
    sandbox: { ...settings.sandbox, enabled: false },
    // Pre-accepts the bypass-mode warning dialog Claude Code otherwise shows
    // on every launch that starts in bypass from settings.
    skipDangerousModePermissionPrompt: true,
  };
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
 * reach is already inside the container. `hasSeenAutoDefaultNudge` dismisses
 * the one-time "make auto mode your default?" prompt shown when a session
 * starts in bypass mode — it defaults to Yes, so a stray Enter would rewrite
 * the agent profile's settings to auto mode.
 */
export function claudeConfigJson(
  packages: Tool[],
  projectContainerPaths: string[],
  agents: readonly KnownAgent[],
): string | null {
  if (!workspaceHasClaudeCode(packages, agents)) return null;
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
  return JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoDefaultNudge: true, projects }, null, 2);
}

/** Return container env vars needed by the workspace's agents. */
export function agentContainerEnv(
  packages: Tool[],
  agents: readonly KnownAgent[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pkg of packages) {
    const agent = knownAgentForPackage(pkg, agents);
    if (agent !== undefined) {
      Object.assign(env, agent.container_env);
    }
  }
  return env;
}

/**
 * A launcher wrapper to bake into the image: the binary to shadow, the flag it
 * must add, and — for a native install only — the home-relative bin dir the
 * real binary lives in, since that is outside the npm prefixes the wrapper
 * would otherwise be the only place to look.
 */
export interface AgentWrap {
  binary: string;
  flag: string;
  bin_dir?: string;
}

/** Return the agents that still require launcher wrapping to enable skip-permissions mode. */
export function agentsWithSkipPermissions(
  packages: Tool[],
  agents: readonly KnownAgent[],
): AgentWrap[] {
  return packages.flatMap((pkg): AgentWrap[] => {
    const agent = knownAgentForPackage(pkg, agents);
    // Claude Code takes its skip-permissions mode from its user settings
    // (claudeUserSettingsJson), so it needs no launcher wrapper.
    if (agent === undefined || agent.skip_permissions_flag === undefined || isBuiltInClaudeCode(agent)) {
      return [];
    }
    const wrap: AgentWrap = { binary: agent.binary, flag: agent.skip_permissions_flag };
    return [agent.install.method === 'native' ? { ...wrap, bin_dir: agent.install.bin_dir } : wrap];
  });
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

/** Claude Code's home-relative config dir: its agent-profile mount and settings home. */
export const CLAUDE_DOT_DIR = '.claude';

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code@latest',
    binary: 'claude',
    dot_dirs: [CLAUDE_DOT_DIR],
    host_mode_supported: false,
    skip_permissions_flag: '--dangerously-skip-permissions',
    // Opt-outs that cost no features. Not DISABLE_TELEMETRY/DO_NOT_TRACK:
    // both also stop feature-flag fetching (Remote Control and other
    // flag-gated features). Not CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: it
    // also disables the auto-updater the native install relies on.
    container_env: {
      CLAUDE_CODE_SANDBOXED: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_FEEDBACK_COMMAND: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    },
    api_key_vars: ['ANTHROPIC_API_KEY'],
    isolated_seed_files: [],
    // Native layout: ~/.local/bin/claude is a symlink into
    // ~/.local/share/claude/versions/<v>; the auto-updater swaps it atomically,
    // so freshness comes from the agent itself, and both dirs are live host
    // mounts so every update persists across container lives.
    // Download-then-run, not `curl | bash`: plain `sh -c` has no pipefail, so
    // a piped curl failure would still look like a successful install.
    install: {
      method: 'native',
      install_command:
        'curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh && rm /tmp/claude-install.sh',
      installed_path: '.local/bin/claude',
      persist_dirs: ['.local/share/claude', '.local/bin'],
      bin_dir: '.local/bin',
      musl_packages: ['libgcc', 'libstdc++', 'ripgrep'],
      musl_env: { USE_BUILTIN_RIPGREP: '0' },
    },
  },
  {
    name: 'Pi',
    package: '@earendil-works/pi-coding-agent@latest',
    binary: 'pi',
    dot_dirs: ['.pi'],
    host_mode_supported: true,
    install: { method: 'npm' },
    container_env: {},
    // The widely-used subset of Pi's provider env map (pi-ai env-api-keys.ts);
    // Pi reads many more, forwardable by hand via workspace host.env.
    api_key_vars: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'XAI_API_KEY',
      'GROQ_API_KEY',
      'DEEPSEEK_API_KEY',
      'MISTRAL_API_KEY',
      'CEREBRAS_API_KEY',
      'ZAI_API_KEY',
      'MOONSHOT_API_KEY',
    ],
    // Pi always runs in skip-permissions mode — no flag needed
    isolated_seed_files: [{ path: '.pi/agent/trust.json', content: PI_TRUST_SEED }],
  },
  {
    name: 'Codex',
    package: '@openai/codex@latest',
    binary: 'codex',
    dot_dirs: ['.codex'],
    host_mode_supported: true,
    // Codex ships a native installer but no self-update mechanism, so the npm
    // refresh path stays its freshness story.
    install: { method: 'npm' },
    host_mode_warning:
      'Shared mode persists login via ~/.codex/auth.json, which is the default. If you set cli_auth_credentials_store = "keyring" (or "auto" on macOS, which prefers the OS keychain), the credential lives outside ~/.codex and will not transfer — choose Isolated instead.',
    skip_permissions_flag: '--dangerously-bypass-approvals-and-sandbox',
    container_env: {},
    api_key_vars: ['OPENAI_API_KEY'],
    isolated_seed_files: [],
  },
  {
    name: 'OpenCode',
    package: 'opencode-ai@latest',
    binary: 'opencode',
    dot_dirs: ['.local/share/opencode', '.config/opencode'],
    host_mode_supported: true,
    // Flat single binary; opencode replaces it by rename when it auto-updates
    // on startup, and the bin dir is a live host mount so the update persists.
    // --no-modify-path: the image ENV PATH covers ~/.opencode/bin.
    // Download-then-run for the same no-pipefail reason as Claude above.
    install: {
      method: 'native',
      install_command:
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && bash /tmp/opencode-install.sh --no-modify-path && rm /tmp/opencode-install.sh',
      installed_path: '.opencode/bin/opencode',
      persist_dirs: ['.opencode/bin'],
      bin_dir: '.opencode/bin',
      musl_packages: [],
      musl_env: {},
    },
    // No skip-permissions flag needed (edit/bash default to "allow"); see
    // OPENCODE_SANDBOX_CONFIG above for the external_directory bypass.
    container_env: { OPENCODE_CONFIG_CONTENT: OPENCODE_SANDBOX_CONFIG },
    // GOOGLE_GENERATIVE_AI_API_KEY, not GEMINI_API_KEY: OpenCode's google
    // provider reads the AI-SDK default name.
    api_key_vars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    isolated_seed_files: [],
  },
  {
    name: 'Amp',
    package: '@ampcode/cli@latest',
    binary: 'amp',
    dot_dirs: ['.local/share/amp', '.config/amp'],
    host_mode_supported: true,
    install: { method: 'npm' },
    container_env: {},
    api_key_vars: ['AMP_API_KEY'],
    isolated_seed_files: [],
    // Amp runs without approval prompts by default — no flag needed.
  },
  {
    name: 'Copilot',
    package: '@github/copilot@latest',
    binary: 'copilot',
    dot_dirs: ['.copilot'],
    host_mode_supported: true,
    // On macOS the login token lives in the Keychain; on headless Linux it
    // falls back to a plain file under ~/.copilot, so an in-container
    // `copilot login` (device code) persists via the shared dir.
    host_mode_warning:
      'A macOS login is stored in the Keychain and does not transfer. Authenticate in-container '
      + 'instead: forward a GitHub token env var, or run `copilot login` once — the device-code '
      + 'flow persists to the shared ~/.copilot.',
    // --yolo = --allow-all-tools --allow-all-paths --allow-all-urls; the
    // container is the boundary, and multi-project workspaces need the paths
    // grant, not just the tools one.
    skip_permissions_flag: '--yolo',
    // Updater stays on, as for the other native installs: it swaps the binary
    // in place and stages packages in ~/.cache/copilot — both on live mounts.
    container_env: {},
    // Precedence order. Fine-grained PATs need the "Copilot Requests"
    // permission; classic ghp_ tokens are rejected.
    api_key_vars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    isolated_seed_files: [],
    // PREFIX pinned: the script defaults to /usr/local when run as root.
    // Download-then-run, not `curl | bash`: plain `sh -c` has no pipefail.
    install: {
      method: 'native',
      install_command:
        'curl -fsSL https://gh.io/copilot-install -o /tmp/copilot-install.sh && PREFIX="$HOME/.local" bash /tmp/copilot-install.sh && rm /tmp/copilot-install.sh',
      installed_path: '.local/bin/copilot',
      // .cache/copilot holds the versioned package the binary stub actually
      // executes; the updater writes both there and over the binary itself.
      persist_dirs: ['.local/bin', '.cache/copilot'],
      bin_dir: '.local/bin',
      // The install script fetches the glibc build even on musl (no libc
      // detection upstream), so Alpine bases fail at install.
      musl_packages: [],
      musl_env: {},
    },
  },
  {
    name: 'Crush',
    // npm wrapper: postinstall downloads the static Go binary from GitHub
    // releases (glibc and musl both fine), so image builds need network.
    package: '@charmland/crush@latest',
    binary: 'crush',
    dot_dirs: ['.config/crush', '.local/share/crush'],
    // `crush login` tokens land in ~/.local/share/crush/crush.json on every
    // platform, so a host login transfers — no warning needed.
    host_mode_supported: true,
    install: { method: 'npm' },
    skip_permissions_flag: '--yolo',
    container_env: {},
    // The widely-used subset of Crush's catwalk provider catalog; it reads
    // more (MINIMAX_API_KEY, HF_TOKEN, …), forwardable via workspace env.
    api_key_vars: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'XAI_API_KEY',
      'GROQ_API_KEY',
      'DEEPSEEK_API_KEY',
      'CEREBRAS_API_KEY',
      'ZAI_API_KEY',
      'MOONSHOT_API_KEY',
    ],
    isolated_seed_files: [],
  },
  {
    name: 'Antigravity',
    // No npm package: `agy` ships only as a curl-script install, so the
    // upstream binary name is the identity (agent list, workspace tools).
    package: 'agy',
    binary: 'agy',
    // Everything — settings, conversations, the file-based OAuth token the
    // CLI falls back to without an OS keyring — lives under
    // ~/.gemini/antigravity-cli/.
    dot_dirs: ['.gemini'],
    host_mode_supported: true,
    host_mode_warning:
      'A macOS login is stored in the Keychain and does not transfer. Authenticate in-container '
      + 'instead: forward GEMINI_API_KEY (needs modelProvider "gemini" in settings.json), or '
      + 'complete the paste-code login once — the token file persists to the shared ~/.gemini.',
    skip_permissions_flag: '--dangerously-skip-permissions',
    // No browser env needed: agy detects headless environments and prints a
    // paste-code URL. Its own updater stays on, as for the other native
    // installs — the binary lives on the .local/bin live mount.
    container_env: {},
    // Only honoured with modelProvider "gemini" in
    // ~/.gemini/antigravity-cli/settings.json; the README documents the pair.
    api_key_vars: ['GEMINI_API_KEY'],
    isolated_seed_files: [],
    install: {
      method: 'native',
      install_command:
        'curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh && bash /tmp/agy-install.sh && rm /tmp/agy-install.sh',
      installed_path: '.local/bin/agy',
      persist_dirs: ['.local/bin'],
      bin_dir: '.local/bin',
      // glibc only: upstream publishes no musl build (the installer's musl
      // manifest 404s), and no package list can supply a missing binary.
      musl_packages: [],
      musl_env: {},
    },
  },
];
