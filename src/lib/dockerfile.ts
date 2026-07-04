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

// Generate a helper shell function that applies agent binary wrappers.
// Used both at startup (wrap existing binaries) and after background update
// (re-wrap updated binaries). Emitting a function avoids duplicating the
// wrapping logic in two places inside the entrypoint script.
function generateWrapFunction(agentWraps: AgentWrap[]): string[] {
  if (agentWraps.length === 0) return [];

  const lines = ['_pitin_wrap_agents() {'];
  for (const { binary, flag } of agentWraps) {
    lines.push(
      `  real="$(which ${binary} 2>/dev/null)"`,
      '  if [ -n "$real" ]; then',
      '    # Remove previous wrapper if present so we can re-wrap after update',
      '    if [ -f "$real"-real ]; then',
      '      mv -f "$real"-real "$real"',
      '    fi',
      '    mv "$real" "$real"-real',
      `    printf '#!/bin/sh\\nexec "%s-real" ${flag} "$@"\\n' "$real" > "$real"`,
      '    chmod +x "$real"',
      '  fi',
    );
  }
  lines.push('}');
  return lines;
}

function generateEntrypoint(packageSpecs: string[], agentWraps: AgentWrap[]): string {
  const lines = ['#!/bin/sh'];

  // Define the wrap function (if there are agents to wrap)
  lines.push(...generateWrapFunction(agentWraps));

  // Phase 1: Wrap existing agent binaries immediately so the user can start
  // working right away with the versions baked into the image.
  if (agentWraps.length > 0) {
    lines.push(
      '',
      '# Wrap agent binaries immediately (pre-update)',
      '_pitin_wrap_agents',
    );
  }

  // Phase 2: Background npm refresh + re-wrap so the shell is not blocked.
  // Reinstall the original package specs rather than using `npm update -g`.
  // This preserves user intent for exact versions and dist-tags like `latest`.
  const quoted = packageSpecs.map((s) => `"${s}"`).join(' ');
  const onUpdateSuccess = agentWraps.length > 0 ? ['    _pitin_wrap_agents'] : ['    :'];
  lines.push(
    '',
    '# Background update — shell is available immediately',
    '(',
    `  _pitin_npm_err="$(mktemp 2>/dev/null || echo /tmp/pi-tin-npm-update.err)"`,
    `  if npm install -g --fetch-timeout=60000 --fetch-retries=0 ${quoted} >/dev/null 2>"$_pitin_npm_err"; then`,
    // Silent on success — the startup message already set expectations
    ...onUpdateSuccess,
    '  else',
    '    echo "pi-tin: agent update failed, continuing with existing versions" >&2',
    '  fi',
    '  rm -f "$_pitin_npm_err"',
    ') &',
  );

  // Configure gh as git credential helper if gh config is mounted
  lines.push(
    '',
    'if [ -d "$HOME/.config/gh" ]; then',
    '  if command -v gh >/dev/null 2>&1; then',
    '    git config --global credential.https://github.com.helper "!gh auth git-credential"',
    '    git config --global credential.https://gist.github.com.helper "!gh auth git-credential"',
    '  else',
    '    echo "Warning: host.githubCLI is enabled but \'gh\' is not installed in this profile. HTTPS git auth will not work." >&2',
    '  fi',
    'fi',
  );

  lines.push('exec "$@"');
  return lines.join('\n');
}

export function generateDockerfile(
  profile: ContainerProfile,
  packages: Tool[],
  opts: {
    agentWraps: AgentWrap[];
    agentEnv: Record<string, string>;
    claudeManagedSettings: string | null;
    claudeConfig: string | null;
  },
): DockerfileResult {
  const lines: string[] = [];
  const extras: Array<{ name: string; content: string }> = [];

  const pm = resolvePackageManager(profile);

  lines.push(`FROM ${profile.base_image}`);
  lines.push('');

  const allPackages = [...profile.packages, ...profile.extra_packages];
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
  lines.push(`ENV PATH=$HOME_DIR/.npm-global/bin:$PATH`);
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

  // Entrypoint script (copied as root before user switch)
  const packageSpecs = packages.map((pkg) => pkg.package);
  if (packages.length > 0) {
    const entrypoint = generateEntrypoint(packageSpecs, agentWraps);
    lines.push(
      'COPY pi-tin-entrypoint /usr/local/bin/pi-tin-entrypoint',
      'RUN chmod +x /usr/local/bin/pi-tin-entrypoint',
    );
    lines.push('');
    extras.push({ name: 'pi-tin-entrypoint', content: entrypoint });
  }

  // Fix ownership of home directory after all root installs
  lines.push(`RUN chown -R ${user}:${user} ${homeDir}`);
  lines.push('');

  // Switch to non-root user
  lines.push(`USER ${user}`);
  lines.push('WORKDIR /workspace');
  lines.push('');

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
