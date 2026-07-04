import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  getConfigDir,
  getContainerProfilesDir,
  getWorkspacesDir,
  getAgentProfilesDir,
  getTmuxConfigsDir,
} from './paths.js';
import { atomicWriteFile } from './atomic-write.js';

const MANAGED_HEADER = '# This profile is managed by pi-tin and will be overwritten on update.';

const PROFILE_HEADER = `${MANAGED_HEADER}
# To customize, copy this file to a new name and modify the copy.`;

// Tools every managed profile ships: a baseline of common dev utilities plus
// the modern search/navigation CLIs coding agents lean on (ripgrep, fd, tree)
// and interactive niceties (bat, fzf). This is the single source — adding a
// package here adds it to every default profile. fd/bat are aliased in
// BASELINE_POST_INSTALL because Debian renames their binaries to fdfind/batcat.
const COMMON_PACKAGES = `  - git
  - curl
  - less
  - procps
  - jq
  - nano
  - vim
  - zsh
  - iputils-ping
  - bind9-host
  - tmux
  - tzdata
  - ca-certificates
  - ripgrep
  - fd-find
  - bat
  - fzf
  - tree`;

// System libraries Playwright's bundled Chromium needs at runtime.
const PLAYWRIGHT_PACKAGES = `  - libglib2.0-0
  - libnspr4
  - libnss3
  - libatk1.0-0
  - libatk-bridge2.0-0
  - libdbus-1-3
  - libcups2
  - libxcb1
  - libxkbcommon0
  - libasound2
  - libgbm1
  - libx11-6
  - libxext6
  - libcairo2
  - libpango-1.0-0
  - libxcomposite1
  - libxdamage1
  - libxfixes3
  - libxrandr2`;

// Install a current Node.js via NodeSource on profiles whose base image is not
// Node-based. Debian's apt nodejs is EOL, and pi-tin installs all agent/global
// tooling with npm, so every profile needs a current Node.
const NODESOURCE_INSTALL = `  - 'curl -fsSL https://deb.nodesource.com/setup_26.x | bash - && apt-get install -y --no-install-recommends nodejs && apt-get clean && rm -rf /var/lib/apt/lists/*'`;

// Shell baseline shared by every profile: `chsh` to zsh (pi-tin enters via the
// login shell), then Oh My Zsh, zoxide, fd/bat aliases (Debian renames the
// binaries to fdfind/batcat), tmux defaults, GitHub CLI.
const BASELINE_POST_INSTALL = `  - 'chsh -s "$(command -v zsh)" "$USERNAME"'
  - 'HOME=$HOME_DIR sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" -- --unattended'
  - 'curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh'
  - 'echo "export PATH=\\"/root/.local/bin:$HOME_DIR/.local/bin:\\$PATH\\"" >> $HOME_DIR/.zshrc'
  - 'echo "eval \\"\\$(zoxide init zsh --cmd cd)\\"" >> $HOME_DIR/.zshrc'
  - 'echo "alias fd=fdfind" >> $HOME_DIR/.zshrc'
  - 'echo "alias bat=batcat" >> $HOME_DIR/.zshrc'
  - 'echo "set -g default-terminal \"tmux-256color\"" > /etc/tmux.conf'
  - 'echo "set -g extended-keys on" >> /etc/tmux.conf'
  - 'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y --no-install-recommends gh && apt-get clean && rm -rf /var/lib/apt/lists/*'`;

// Locale + CA defaults shared by every profile.
const COMMON_ENV = `  NODE_EXTRA_CA_CERTS: /etc/ssl/certs/ca-certificates.crt
  LANG: C.UTF-8
  LC_ALL: C.UTF-8`;

// Container-internal state pi-tin snapshots across container lives (see
// workspace-state.ts). Tied to the shared shell baseline above: zoxide's
// frecency DB and zsh history. Custom profiles can extend this per their tools.
const COMMON_WORKSPACE_STATE = `  - .local/share/zoxide
  - .zsh_history`;

export const DEFAULT_CONTAINER_PROFILES: Record<string, string> = {
  'node-dev': `${PROFILE_HEADER}

description: "Node.js with dev tools and Playwright"
base_image: node:trixie-slim
user: dev

packages:
${COMMON_PACKAGES}
  - python3
  - python-is-python3

extra_packages:
${PLAYWRIGHT_PACKAGES}

global_tools:
  - "@playwright/cli@latest"

post_install:
${BASELINE_POST_INSTALL}

post_setup:
  - "playwright-cli install-browser chromium"

env:
  PLAYWRIGHT_MCP_BROWSER: chromium
${COMMON_ENV}

workspace_state:
${COMMON_WORKSPACE_STATE}

`,
  'bun-dev': `${PROFILE_HEADER}

description: "Bun with Node.js/npm, dev tools, and Playwright"
base_image: oven/bun:slim
package_manager: apt
user: dev

packages:
${COMMON_PACKAGES}

extra_packages:
${PLAYWRIGHT_PACKAGES}

global_tools:
  - "@playwright/cli@latest"

post_install:
${NODESOURCE_INSTALL}
${BASELINE_POST_INSTALL}

post_setup:
  - "playwright-cli install-browser chromium"

env:
  PLAYWRIGHT_MCP_BROWSER: chromium
${COMMON_ENV}

workspace_state:
${COMMON_WORKSPACE_STATE}

`,
  'python-dev': `${PROFILE_HEADER}

description: "Python 3.13 with uv, pip/venv, build tools, and Node.js for agent tooling"
base_image: python:3.13-slim
package_manager: apt
user: dev

packages:
  - build-essential
${COMMON_PACKAGES}

extra_packages: []

global_tools: []

post_install:
${NODESOURCE_INSTALL}
  - 'pip install --no-cache-dir uv'
${BASELINE_POST_INSTALL}

post_setup: []

env:
${COMMON_ENV}

workspace_state:
${COMMON_WORKSPACE_STATE}

`,
  'rust-dev': `${PROFILE_HEADER}

description: "Rust via rustup with build tools and Node.js for agent tooling"
base_image: debian:trixie-slim
user: dev

packages:
  - build-essential
  - pkg-config
  - libssl-dev
${COMMON_PACKAGES}

extra_packages: []

global_tools: []

post_install:
${NODESOURCE_INSTALL}
${BASELINE_POST_INSTALL}

post_setup:
  - "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path"
  - 'echo "export PATH=\\"$HOME_DIR/.cargo/bin:\\$PATH\\"" >> $HOME_DIR/.zshrc'

env:
${COMMON_ENV}

workspace_state:
${COMMON_WORKSPACE_STATE}

`,
  'dotnet-dev': `${PROFILE_HEADER}

description: ".NET SDK 10.0 with dev tools and Node.js for agent tooling"
base_image: mcr.microsoft.com/dotnet/sdk:10.0
package_manager: apt
user: dev

packages:
${COMMON_PACKAGES}

extra_packages: []

global_tools: []

post_install:
${NODESOURCE_INSTALL}
${BASELINE_POST_INSTALL}

post_setup: []

env:
  DOTNET_CLI_TELEMETRY_OPTOUT: "1"
  DOTNET_NOLOGO: "1"
${COMMON_ENV}

workspace_state:
${COMMON_WORKSPACE_STATE}

`,
};

export function syncDefaultContainerProfiles(profilesDir: string): string[] {
  fs.mkdirSync(profilesDir, { recursive: true });
  const messages: string[] = [];

  for (const [name, content] of Object.entries(DEFAULT_CONTAINER_PROFILES)) {
    const filePath = path.join(profilesDir, `${name}.yaml`);

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing === content) {
        continue;
      }
      // Don't overwrite if user removed the managed header
      if (!existing.startsWith(MANAGED_HEADER)) {
        continue;
      }
      messages.push(`Default profile '${name}' has been updated`);
    }

    atomicWriteFile(filePath, content);
  }

  return messages;
}

export function ensureInitialised(): { firstRun: boolean } {
  const isFirstRun = !fs.existsSync(getConfigDir());

  // Idempotent per-path so a partially-deleted config dir is repaired, not
  // just detected on a pristine first run.
  fs.mkdirSync(getContainerProfilesDir(), { recursive: true });
  fs.mkdirSync(getWorkspacesDir(), { recursive: true });
  fs.mkdirSync(getAgentProfilesDir(), { recursive: true });
  fs.mkdirSync(getTmuxConfigsDir(), { recursive: true });

  const messages = syncDefaultContainerProfiles(getContainerProfilesDir());
  for (const msg of messages) {
    console.error(chalk.blue(msg));
  }

  return { firstRun: isFirstRun };
}
