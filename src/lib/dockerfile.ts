import { containerHomeDir } from './paths.js';
import type { ContainerProfile, Tool } from './validators.js';

export interface DockerfileResult {
  dockerfile: string;
  extras: Array<{ name: string; content: string }>;
}

export type PackageManager = 'apt' | 'apk' | 'dnf';

const IMAGE_PATTERNS: Array<{ test: RegExp; pm: PackageManager }> = [
  { test: /alpine/, pm: 'apk' },
  { test: /^(fedora|rockylinux|almalinux)([:\/]|$)|\/rhel|\/ubi/, pm: 'dnf' },
  { test: /^(debian|ubuntu|node|python|oven\/bun|buildpack-deps)([:\/]|$)/, pm: 'apt' },
];

// Detect the package manager from a base image name, or null when the name
// matches no known distro. The alpine pattern is tested first, so Debian-based
// `python:*-alpine` / `oven/bun:*-alpine` still correctly resolve to apk.
export function detectPackageManager(baseImage: string): PackageManager | null {
  const image = baseImage.toLowerCase();
  for (const { test, pm } of IMAGE_PATTERNS) {
    if (test.test(image)) return pm;
  }
  return null;
}

function resolvePackageManager(profile: ContainerProfile): PackageManager {
  if (profile.package_manager) return profile.package_manager;
  const pm = detectPackageManager(profile.base_image);
  if (pm === null) {
    throw new Error(
      `Cannot detect package manager for base image '${profile.base_image}'. ` +
      `Add 'package_manager: apt | apk | dnf' to your profile YAML.`,
    );
  }
  return pm;
}

function installPackagesLines(pm: PackageManager, packages: string[]): string[] {
  const pkgList = packages.map((pkg) => `    ${pkg}`).join(' \\\n');
  switch (pm) {
    case 'apt':
      return [
        'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\',
        pkgList + ' \\',
        '    && apt-get clean && rm -rf /var/lib/apt/lists/*',
      ];
    case 'apk':
      return [
        'RUN apk add --no-cache \\',
        pkgList,
      ];
    case 'dnf':
      return [
        'RUN dnf install -y --setopt=install_weak_deps=False \\',
        pkgList + ' \\',
        '    && dnf clean all',
      ];
  }
}

// No --shell here: profiles own the login shell (managed ones `chsh` to zsh in
// post_install), and omitting it avoids a build break when a profile ships no
// shell binary.
function createUserLines(pm: PackageManager): string[] {
  switch (pm) {
    case 'apt':
    case 'dnf':
      return [
        'RUN groupadd --force $USERNAME \\',
        `    && (id -u $USERNAME >/dev/null 2>&1 || useradd --create-home --gid $USERNAME $USERNAME)`,
      ];
    case 'apk':
      return [
        `RUN addgroup -S $USERNAME 2>/dev/null || true \\`,
        `    && (id -u $USERNAME >/dev/null 2>&1 || adduser -D -G $USERNAME $USERNAME)`,
      ];
  }
}

export interface AgentWrap {
  binary: string;
  flag: string;
}

const CLAUDE_MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.d/90-pi-tin-claude-settings.json';

// pi-tin installs all agent tools and `global_tools` with npm, whatever the base
// image. A custom profile that ships no Node.js would otherwise fail deep in the
// build with npm's own "not found" error; this guard fails early with an
// actionable message instead. Managed profiles install Node.js via NodeSource.
const NPM_PREFLIGHT =
  'RUN command -v npm >/dev/null 2>&1 || { echo "pi-tin: this workspace installs npm packages (agent tools and/or global_tools) but npm is not available in this image. Install Node.js in the container profile (e.g. a NodeSource step in post_install, as the managed profiles do) or remove the tools." >&2; exit 1; }';

// Escape a value for safe use inside a Dockerfile `ENV KEY="..."` directive.
// Protects against malformed Dockerfiles (stray `"`) and unintended build-time
// variable expansion (`$VAR`). Backslashes must be escaped first.
export function dockerfileEnvQuote(value: string): string {
  return '"' + value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$') + '"';
}

/** Container path of the agent-refresh script; `pi-tin open` execs it detached. */
export const REFRESH_SCRIPT_PATH = '/usr/local/bin/pi-tin-refresh-agents';

/** Container path of the sshd launcher; the container command when sshd is enabled. */
export const SSHD_LAUNCH_PATH = '/usr/local/bin/pi-tin-sshd-launch';

// Unprivileged sshd cannot bind below 1024; one fixed high port works because
// every workspace container has its own IP.
export const WORKSPACE_SSHD_PORT = 2222;

const SSHD_CONFIG_DIR_RELATIVE = '.config/pi-tin-sshd';

const AGENT_WRAPPER_BIN_DIR = '/usr/local/pi-tin/bin';

// Launcher baked at build time, first on PATH. Tries the refresh prefix, then
// the image-baked prefix: background refreshes never touch the baked install,
// so one of the two always resolves — even mid-install, when npm has removed
// the refresh prefix's bin links (Arborist retires them before relinking).
function generateAgentWrapper(wrap: AgentWrap): string {
  return [
    '#!/bin/sh',
    'for prefix_bin in "$HOME/.npm-refresh/bin" "$HOME/.npm-global/bin"; do',
    `  if [ -x "$prefix_bin/${wrap.binary}" ]; then`,
    `    exec "$prefix_bin/${wrap.binary}" ${wrap.flag} "$@"`,
    '  fi',
    'done',
    `echo "pi-tin: ${wrap.binary} not found in workspace npm prefixes" >&2`,
    'exit 127',
  ].join('\n');
}

// Reinstall the original package specs rather than `npm update -g` — this
// preserves user intent for exact versions and dist-tags like `latest`.
// Installs land in a shadow prefix that PATH prefers once populated: npm
// removes bin links mid-install, so reinstalling over the live prefix would
// leave agents unavailable for the duration. The baked prefix is the
// untouched fallback; a failed refresh simply keeps existing versions.
function generateRefreshScript(packageSpecs: string[]): string {
  const quoted = packageSpecs.map((s) => `"${s}"`).join(' ');
  return [
    '#!/bin/sh',
    '# One refresh at a time; a concurrent `pi-tin open` skips instead of colliding.',
    'if ! mkdir /tmp/pi-tin-refresh.lock 2>/dev/null; then',
    '  exit 0',
    'fi',
    "trap 'rmdir /tmp/pi-tin-refresh.lock' EXIT",
    '',
    `if ! npm install -g --prefix "$HOME/.npm-refresh" --fetch-timeout=60000 --fetch-retries=0 ${quoted} >/dev/null 2>&1; then`,
    '  echo "pi-tin: agent refresh failed, continuing with existing versions" >&2',
    'fi',
  ].join('\n');
}

// The workspace user owns sshd entirely: config and host keys live under the
// home dir because root-owned /etc/ssh keys are unreadable by an unprivileged
// sshd. UsePAM must be off (PAM needs root); PermitUserEnvironment pairs with
// the launcher's env snapshot below.
function generateSshdConfig(user: string, homeDir: string): string {
  return [
    `Port ${WORKSPACE_SSHD_PORT}`,
    'ListenAddress 0.0.0.0',
    `HostKey ${homeDir}/${SSHD_CONFIG_DIR_RELATIVE}/ssh_host_ed25519_key`,
    'PidFile none',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'AuthorizedKeysFile .ssh/authorized_keys',
    'PermitUserEnvironment yes',
    `AllowUsers ${user}`,
    'X11Forwarding no',
    'Subsystem sftp internal-sftp',
    'LogLevel INFO',
  ].join('\n');
}

// sshd scrubs the environment for sessions; PermitUserEnvironment plus this
// snapshot restores the container env (image ENV, runtime --env-file values,
// SSH_AUTH_SOCK, PATH) so ssh sessions match `container exec` sessions. The
// ^KEY= anchor drops continuation lines of multiline image ENV values (same
// rationale as partitionEnvForFile: config is trusted, this is robustness).
// Login-owned vars are excluded so ssh/login set them per session.
function generateSshdLauncher(): string {
  return [
    '#!/bin/sh',
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    "env | LC_ALL=C grep -E '^[A-Za-z_][A-Za-z0-9_]*=' \\",
    "  | grep -vE '^(HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|HOSTNAME|TERM|_)=' \\",
    '  > "$HOME/.ssh/environment"',
    `exec /usr/sbin/sshd -D -e -f "$HOME/${SSHD_CONFIG_DIR_RELATIVE}/sshd_config"`,
  ].join('\n');
}

function generateEntrypoint(): string {
  // Configure gh as git credential helper if gh config is mounted
  return [
    '#!/bin/sh',
    'if [ -d "$HOME/.config/gh" ]; then',
    '  if command -v gh >/dev/null 2>&1; then',
    '    git config --global credential.https://github.com.helper "!gh auth git-credential"',
    '    git config --global credential.https://gist.github.com.helper "!gh auth git-credential"',
    '  else',
    '    echo "Warning: host.githubCLI is enabled but \'gh\' is not installed in this profile. HTTPS git auth will not work." >&2',
    '  fi',
    'fi',
    'exec "$@"',
  ].join('\n');
}

export function generateDockerfile(
  profile: ContainerProfile,
  packages: Tool[],
  opts: {
    agentWraps: AgentWrap[];
    agentEnv: Record<string, string>;
    claudeManagedSettings: string | null;
    claudeConfig: string | null;
    sshd: { authorizedKey: string } | null;
  },
): DockerfileResult {
  const lines: string[] = [];
  const extras: Array<{ name: string; content: string }> = [];

  const pm = resolvePackageManager(profile);

  lines.push(`FROM ${profile.base_image}`);
  lines.push('');

  const allPackages = [
    ...profile.packages,
    ...profile.extra_packages,
    // Same package name across apt/apk/dnf; each pulls its ssh-keygen dependency.
    ...(opts.sshd !== null ? ['openssh-server'] : []),
  ];
  if (allPackages.length > 0) {
    lines.push(...installPackagesLines(pm, allPackages));
    lines.push('');
  }

  const user = profile.user;
  const homeDir = containerHomeDir(user);
  const hasSudo = allPackages.includes('sudo');
  lines.push(`ARG USERNAME=${user}`);
  lines.push(`ARG HOME_DIR=${homeDir}`);
  lines.push(...createUserLines(pm));
  if (hasSudo) {
    lines.push(
      `RUN echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \\`,
      '    && chmod 0440 /etc/sudoers.d/$USERNAME',
    );
  }
  lines.push('');

  lines.push(
    `RUN mkdir -p /workspace && chown -R ${user}:${user} /workspace`,
  );
  lines.push('');

  // User-writable npm global prefix (no sudo needed for npm install -g)
  lines.push(
    `RUN mkdir -p $HOME_DIR/.npm-global \\`,
    `    && echo "prefix=$HOME_DIR/.npm-global" > $HOME_DIR/.npmrc`,
  );
  lines.push('');

  lines.push(`ENV HOME=$HOME_DIR`);
  // Wrapper launchers first, then the refresh prefix, then the baked prefix —
  // missing dirs are inert, so the line is unconditional. With sshd, .local/bin
  // joins the image PATH: non-interactive ssh reads no .zshrc, and remote
  // clients (herdr) locate/auto-install their server binary there.
  const sshdPathSuffix = opts.sshd !== null ? ':$HOME_DIR/.local/bin' : '';
  lines.push(`ENV PATH=${AGENT_WRAPPER_BIN_DIR}:$HOME_DIR/.npm-refresh/bin:$HOME_DIR/.npm-global/bin${sshdPathSuffix}:$PATH`);
  const { agentWraps, agentEnv, claudeManagedSettings, claudeConfig } = opts;
  for (const [key, value] of Object.entries(agentEnv)) {
    lines.push(`ENV ${key}=${dockerfileEnvQuote(value)}`);
  }
  for (const [key, value] of Object.entries(profile.env)) {
    lines.push(`ENV ${key}=${dockerfileEnvQuote(value)}`);
  }
  lines.push('');

  for (const cmd of profile.post_install) {
    lines.push(`RUN ${cmd}`);
  }
  if (profile.post_install.length > 0) {
    lines.push('');
  }

  if (claudeManagedSettings !== null) {
    lines.push(
      'RUN mkdir -p /etc/claude-code/managed-settings.d',
      `COPY claude-managed-settings.json ${CLAUDE_MANAGED_SETTINGS_PATH}`,
    );
    lines.push('');
    extras.push({ name: 'claude-managed-settings.json', content: `${claudeManagedSettings}\n` });
  }

  // Seed ~/.claude.json (onboarding + per-project trust). Copied before the
  // home-dir chown below so it ends up owned by the workspace user.
  if (claudeConfig !== null) {
    lines.push(`COPY claude-config.json ${homeDir}/.claude.json`);
    lines.push('');
    extras.push({ name: 'claude-config.json', content: `${claudeConfig}\n` });
  }

  // Entrypoint, refresh script, and agent wrappers (copied as root before user switch)
  const packageSpecs = packages.map((pkg) => pkg.package);
  if (packages.length > 0) {
    lines.push(
      'COPY pi-tin-entrypoint /usr/local/bin/pi-tin-entrypoint',
      'RUN chmod +x /usr/local/bin/pi-tin-entrypoint',
      `COPY pi-tin-refresh-agents ${REFRESH_SCRIPT_PATH}`,
      `RUN chmod +x ${REFRESH_SCRIPT_PATH}`,
    );
    extras.push({ name: 'pi-tin-entrypoint', content: generateEntrypoint() });
    extras.push({ name: 'pi-tin-refresh-agents', content: generateRefreshScript(packageSpecs) });

    if (agentWraps.length > 0) {
      lines.push(`RUN mkdir -p ${AGENT_WRAPPER_BIN_DIR}`);
      for (const wrap of agentWraps) {
        lines.push(
          `COPY pi-tin-wrapper-${wrap.binary} ${AGENT_WRAPPER_BIN_DIR}/${wrap.binary}`,
          `RUN chmod +x ${AGENT_WRAPPER_BIN_DIR}/${wrap.binary}`,
        );
        extras.push({ name: `pi-tin-wrapper-${wrap.binary}`, content: generateAgentWrapper(wrap) });
      }
    }
    lines.push('');
  }

  // sshd artifacts (copied as root before the home-dir chown below fixes ownership)
  if (opts.sshd !== null) {
    lines.push(
      `COPY pi-tin-sshd-launch ${SSHD_LAUNCH_PATH}`,
      `RUN chmod +x ${SSHD_LAUNCH_PATH}`,
      `RUN mkdir -p $HOME_DIR/.ssh $HOME_DIR/${SSHD_CONFIG_DIR_RELATIVE} && chmod 700 $HOME_DIR/.ssh`,
      `COPY pi-tin-authorized-keys $HOME_DIR/.ssh/authorized_keys`,
      'RUN chmod 600 $HOME_DIR/.ssh/authorized_keys',
      `COPY pi-tin-sshd-config $HOME_DIR/${SSHD_CONFIG_DIR_RELATIVE}/sshd_config`,
    );
    lines.push('');
    extras.push({ name: 'pi-tin-sshd-launch', content: generateSshdLauncher() });
    extras.push({ name: 'pi-tin-authorized-keys', content: `${opts.sshd.authorizedKey}\n` });
    extras.push({ name: 'pi-tin-sshd-config', content: generateSshdConfig(user, homeDir) });
  }

  // Fix ownership of home directory after all root installs
  lines.push(`RUN chown -R ${user}:${user} ${homeDir}`);
  lines.push('');

  // Switch to non-root user
  lines.push(`USER ${user}`);
  lines.push('WORKDIR /workspace');
  lines.push('');

  // Host keys are baked at build so they stay stable across the container's
  // ephemeral lives — start-time keys would churn on every fresh start and
  // trip StrictHostKeyChecking. Generated as the user: an unprivileged sshd
  // cannot read root-owned keys.
  if (opts.sshd !== null) {
    lines.push(`RUN ssh-keygen -q -t ed25519 -N "" -f $HOME_DIR/${SSHD_CONFIG_DIR_RELATIVE}/ssh_host_ed25519_key`);
    lines.push('');
  }

  // Fail early and clearly if the image has no npm but the workspace needs it.
  if (profile.global_tools.length > 0 || packages.length > 0) {
    lines.push(NPM_PREFLIGHT);
    lines.push('');
  }

  // Global tool installs (as user, using npm prefix).
  // Single RUN so npm parallelises fetches and we pay npm's cold start once.
  if (profile.global_tools.length > 0) {
    lines.push(`RUN npm install -g ${profile.global_tools.join(' ')}`);
    lines.push('');
  }

  // Post-setup commands (as user, after global tools are available)
  for (const cmd of profile.post_setup) {
    lines.push(`RUN ${cmd}`);
  }
  if (profile.post_setup.length > 0) {
    lines.push('');
  }

  // Workspace npm packages (as user, using npm prefix).
  // Single RUN so npm parallelises fetches across all packages.
  if (packages.length > 0) {
    lines.push('# Workspace packages');
    lines.push(`RUN npm install -g ${packageSpecs.join(' ')}`);
    lines.push('');
  }

  lines.push('CMD ["/bin/sh"]');

  if (packages.length > 0) {
    lines.push('ENTRYPOINT ["/usr/local/bin/pi-tin-entrypoint"]');
  }

  return { dockerfile: lines.join('\n') + '\n', extras };
}
