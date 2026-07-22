import { describe, test, expect } from 'bun:test';
import { generateDockerfile, detectPackageManager } from './dockerfile.js';
import type { ContainerProfile, Tool } from './validators.js';

const baseProfile: ContainerProfile = {
  description: 'Test profile',
  base_image: 'node:slim',
  user: 'dev',
  packages: ['git', 'curl'],
  extra_packages: [],
  global_tools: [],
  post_install: [],
  post_setup: [],
  env: {},
  workspace_state: [],
};

const noWraps = { agentWraps: [], agentEnv: {}, claudeManagedSettings: null, claudeConfig: null, sshd: null };

describe('generateDockerfile', () => {
  test('produces basic Dockerfile structure', () => {
    const { dockerfile, extras } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).toContain('FROM node:slim');
    expect(dockerfile).toContain('ARG USERNAME=dev');
    expect(dockerfile).toContain('WORKDIR /workspace');
    expect(dockerfile).toContain('CMD ["/bin/sh"]');
    expect(dockerfile).toContain('USER dev');
    expect(extras).toEqual([]);
  });

  test('includes apt packages', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).toContain('apt-get install');
    expect(dockerfile).toContain('git');
    expect(dockerfile).toContain('curl');
  });

  test('quotes env values', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      env: { NODE_ENV: 'production', PATH_EXTRA: '/usr/local/bin' },
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('ENV NODE_ENV="production"');
    expect(dockerfile).toContain('ENV PATH_EXTRA="/usr/local/bin"');
  });

  test('escapes special characters in env values', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      env: {
        WITH_QUOTE: 'foo"bar',
        WITH_DOLLAR: 'literal $VAR stays literal',
        WITH_BACKSLASH: 'a\\b',
        COMBINED: 'mix"$x\\end',
      },
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    // Double quote escaped as \"
    expect(dockerfile).toContain('ENV WITH_QUOTE="foo\\"bar"');
    // $ escaped as \$ so Docker build does not expand it
    expect(dockerfile).toContain('ENV WITH_DOLLAR="literal \\$VAR stays literal"');
    // Backslash escaped as \\
    expect(dockerfile).toContain('ENV WITH_BACKSLASH="a\\\\b"');
    // Combination preserves correct escape order (backslash first, then " and $)
    expect(dockerfile).toContain('ENV COMBINED="mix\\"\\$x\\\\end"');
  });

  test('includes global tools', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      global_tools: ['typescript@latest', '@playwright/cli@latest'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    // Single RUN combines all global tools so npm parallelises fetches.
    expect(dockerfile).toContain('RUN npm install -g typescript@latest @playwright/cli@latest');
  });

  test('includes post-install commands', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      post_install: ['echo "done"'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('RUN echo "done"');
  });

  test('post_setup commands run after global tools and USER switch', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      global_tools: ['@playwright/cli@latest'],
      post_setup: ['playwright-cli install-browser chromium'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    const userLine = dockerfile.indexOf('USER dev');
    const globalToolLine = dockerfile.indexOf('RUN npm install -g @playwright/cli@latest');
    const postSetupLine = dockerfile.indexOf('RUN playwright-cli install-browser chromium');

    expect(userLine).toBeGreaterThan(-1);
    expect(globalToolLine).toBeGreaterThan(-1);
    expect(postSetupLine).toBeGreaterThan(-1);
    expect(postSetupLine).toBeGreaterThan(userLine);
    expect(postSetupLine).toBeGreaterThan(globalToolLine);
  });

  test('appends npm packages and entrypoint when packages provided', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, noWraps);

    expect(dockerfile).toContain('# Workspace packages');
    expect(dockerfile).not.toContain('USER root');
    expect(dockerfile).toContain('RUN npm install -g @anthropic-ai/claude-code@latest');
    expect(dockerfile).toContain('COPY pi-tin-entrypoint');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/pi-tin-entrypoint"]');
    const entrypoint = extras.find((extra) => extra.name === 'pi-tin-entrypoint');
    expect(entrypoint?.content).toContain('#!/bin/sh');
    expect(entrypoint?.content).toContain('exec "$@"');
  });

  test('PATH prefers wrapper and refresh-prefix bins over the baked npm prefix', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).toContain(
      'ENV PATH=/usr/local/pi-tin/bin:$HOME_DIR/.npm-refresh/bin:$HOME_DIR/.npm-global/bin:$PATH',
    );
  });

  test('emits a refresh script installing into the shadow prefix', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, noWraps);

    const refresh = extras.find((extra) => extra.name === 'pi-tin-refresh-agents');
    expect(refresh?.content).toContain('#!/bin/sh');
    expect(refresh?.content).toContain('mkdir /tmp/pi-tin-refresh.lock');
    expect(refresh?.content).toContain(
      'npm install -g --prefix "$HOME/.npm-refresh" --fetch-timeout=60000 --fetch-retries=0 "@anthropic-ai/claude-code@latest"',
    );
    expect(dockerfile).toContain('COPY pi-tin-refresh-agents /usr/local/bin/pi-tin-refresh-agents');
    expect(dockerfile).toContain('RUN chmod +x /usr/local/bin/pi-tin-refresh-agents');
  });

  test('entrypoint does not install or update packages', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { extras } = generateDockerfile(baseProfile, packages, noWraps);

    const entrypoint = extras.find((extra) => extra.name === 'pi-tin-entrypoint');
    expect(entrypoint?.content).not.toContain('npm install');
    expect(entrypoint?.content).toContain('gh auth git-credential');
  });

  test('copies Claude managed settings when provided', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const claudeManagedSettings = JSON.stringify({
      permissions: {
        defaultMode: 'bypassPermissions',
      },
      sandbox: {
        enabled: false,
      },
    }, null, 2);
    const { extras, dockerfile } = generateDockerfile(baseProfile, packages, {
      agentWraps: [],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1' },
      claudeManagedSettings,
      claudeConfig: null,
      sshd: null,
    });

    const settingsFile = extras.find((extra) => extra.name === 'claude-managed-settings.json');
    expect(settingsFile?.content).toContain('"defaultMode": "bypassPermissions"');
    expect(settingsFile?.content).toContain('"enabled": false');
    expect(dockerfile).toContain('COPY claude-managed-settings.json /etc/claude-code/managed-settings.d/90-pi-tin-claude-settings.json');
  });

  test('bakes a PATH-first wrapper for agents with skip-permissions flags', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, {
      agentWraps: [{ binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' }],
      agentEnv: {},
      claudeManagedSettings: null,
      claudeConfig: null,
      sshd: null,
    });

    const wrapper = extras.find((extra) => extra.name === 'pi-tin-wrapper-codex');
    expect(wrapper?.content).toContain('#!/bin/sh');
    expect(wrapper?.content).toContain('"$HOME/.npm-refresh/bin"');
    expect(wrapper?.content).toContain('"$HOME/.npm-global/bin"');
    expect(wrapper?.content).toContain('--dangerously-bypass-approvals-and-sandbox "$@"');
    expect(wrapper?.content).toContain('exit 127');
    expect(dockerfile).toContain('COPY pi-tin-wrapper-codex /usr/local/pi-tin/bin/codex');
    expect(dockerfile).toContain('RUN mkdir -p /usr/local/pi-tin/bin');
    expect(dockerfile).toContain('RUN chmod +x /usr/local/pi-tin/bin/codex');
  });

  test('refresh script preserves original package specs', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Pinned Tool', package: 'typescript@5.9.3' },
    ];
    const { extras } = generateDockerfile(baseProfile, packages, noWraps);

    const refresh = extras.find((extra) => extra.name === 'pi-tin-refresh-agents');
    expect(refresh?.content).toContain(
      'npm install -g --prefix "$HOME/.npm-refresh" --fetch-timeout=60000 --fetch-retries=0 "@anthropic-ai/claude-code@latest" "typescript@5.9.3"',
    );
    expect(refresh?.content).not.toContain('npm update -g');
  });

  test('bakes wrappers for non-Claude agents while Claude uses managed settings', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Codex', package: '@openai/codex@latest' },
      { name: 'Gemini CLI', package: '@google/gemini-cli@latest' },
    ];
    const claudeManagedSettings = JSON.stringify({
      permissions: {
        defaultMode: 'bypassPermissions',
      },
    }, null, 2);
    const { extras, dockerfile } = generateDockerfile(baseProfile, packages, {
      agentWraps: [
        { binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' },
        { binary: 'gemini', flag: '--approval-mode=yolo' },
      ],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1' },
      claudeManagedSettings,
      claudeConfig: null,
      sshd: null,
    });

    expect(extras.find((extra) => extra.name === 'pi-tin-wrapper-claude')).toBeUndefined();
    const codexWrapper = extras.find((extra) => extra.name === 'pi-tin-wrapper-codex');
    expect(codexWrapper?.content).toContain('--dangerously-bypass-approvals-and-sandbox');
    const geminiWrapper = extras.find((extra) => extra.name === 'pi-tin-wrapper-gemini');
    expect(geminiWrapper?.content).toContain('--approval-mode=yolo');
    expect(dockerfile).toContain('COPY pi-tin-wrapper-gemini /usr/local/pi-tin/bin/gemini');
    expect(dockerfile).toContain('ENV CLAUDE_CODE_SANDBOXED="1"');
    expect(dockerfile).toContain('COPY claude-managed-settings.json /etc/claude-code/managed-settings.d/90-pi-tin-claude-settings.json');
  });

  test('agentEnv sets container env vars', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Gemini CLI', package: '@google/gemini-cli@latest' },
    ];
    const { dockerfile } = generateDockerfile(baseProfile, packages, {
      agentWraps: [
        { binary: 'gemini', flag: '--approval-mode=yolo' },
      ],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1', NO_BROWSER: 'true' },
      claudeManagedSettings: null,
      claudeConfig: null,
      sshd: null,
    });

    expect(dockerfile).toContain('ENV CLAUDE_CODE_SANDBOXED="1"');
    expect(dockerfile).toContain('ENV NO_BROWSER="true"');
  });

  test('empty agentEnv does not set agent-specific env vars', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const { dockerfile } = generateDockerfile(baseProfile, packages, {
      agentWraps: [
        { binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' },
      ],
      agentEnv: {},
      claudeManagedSettings: null,
      claudeConfig: null,
      sshd: null,
    });

    expect(dockerfile).not.toContain('CLAUDE_CODE_SANDBOXED');
    expect(dockerfile).not.toContain('NO_BROWSER');
    expect(dockerfile).not.toContain('claude.json');
  });

  test('empty agentWraps produces no wrapper extras', () => {
    const packages: Tool[] = [
      { name: 'Pi', package: '@earendil-works/pi-coding-agent@latest' },
    ];
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, noWraps);

    expect(extras.some((extra) => extra.name.startsWith('pi-tin-wrapper-'))).toBe(false);
    expect(dockerfile).not.toContain('COPY pi-tin-wrapper-');
    expect(dockerfile).not.toContain('mkdir -p /usr/local/pi-tin/bin');
  });

  test('returns no extras when no packages', () => {
    const { extras } = generateDockerfile(baseProfile, [], noWraps);
    expect(extras).toEqual([]);
  });

  test('guards npm availability before installing workspace packages', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { dockerfile } = generateDockerfile(baseProfile, packages, noWraps);

    const guardLine = dockerfile.indexOf('command -v npm');
    const installLine = dockerfile.indexOf('npm install -g @anthropic-ai/claude-code@latest');
    expect(guardLine).toBeGreaterThan(-1);
    expect(installLine).toBeGreaterThan(guardLine);
  });

  test('guards npm availability before installing global tools', () => {
    const profile: ContainerProfile = { ...baseProfile, global_tools: ['typescript@latest'] };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    const guardLine = dockerfile.indexOf('command -v npm');
    const installLine = dockerfile.indexOf('npm install -g typescript@latest');
    expect(guardLine).toBeGreaterThan(-1);
    expect(installLine).toBeGreaterThan(guardLine);
  });

  test('omits the npm guard when the workspace installs nothing via npm', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], noWraps);
    expect(dockerfile).not.toContain('command -v npm');
  });

  test('sets no login shell in useradd; profile owns the shell', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).not.toContain('--shell');
    expect(dockerfile).not.toContain('$(which');
    expect(dockerfile).toContain('CMD ["/bin/sh"]');
  });

  test('copies the seeded ~/.claude.json into the user home when provided', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const claudeConfig = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        '/workspace/pi-tin': {
          hasTrustDialogAccepted: true,
          hasTrustDialogHooksAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    }, null, 2);
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, {
      agentWraps: [],
      agentEnv: {},
      claudeManagedSettings: null,
      claudeConfig,
      sshd: null,
    });

    // Copied before the home-dir chown so the file ends up owned by the user.
    const copyLine = dockerfile.indexOf('COPY claude-config.json /home/dev/.claude.json');
    const chownLine = dockerfile.indexOf('RUN chown -R dev:dev /home/dev');
    expect(copyLine).toBeGreaterThan(-1);
    expect(chownLine).toBeGreaterThan(copyLine);

    const configFile = extras.find((extra) => extra.name === 'claude-config.json');
    expect(configFile?.content).toContain('"hasCompletedOnboarding": true');
    expect(configFile?.content).toContain('"/workspace/pi-tin"');
    expect(configFile?.content).toContain('"hasTrustDialogAccepted": true');
    expect(configFile?.content).toContain('"hasTrustDialogHooksAccepted": true');
  });

  test('omits the ~/.claude.json copy when no Claude config is provided', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const { dockerfile, extras } = generateDockerfile(baseProfile, packages, {
      agentWraps: [{ binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' }],
      agentEnv: {},
      claudeManagedSettings: null,
      claudeConfig: null,
      sshd: null,
    });

    expect(dockerfile).not.toContain('.claude.json');
    expect(extras.find((extra) => extra.name === 'claude-config.json')).toBeUndefined();
  });

  test('uses /root for root user home directory', () => {
    const rootProfile: ContainerProfile = {
      ...baseProfile,
      user: 'root',
    };
    const { dockerfile } = generateDockerfile(rootProfile, [], noWraps);

    expect(dockerfile).toContain('ARG HOME_DIR=/root');
    expect(dockerfile).not.toContain('/home/root');
  });

  test('uses apk for Alpine base image', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'node:alpine',
      packages: ['git', 'curl'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('apk add --no-cache');
    expect(dockerfile).not.toContain('apt-get');
    expect(dockerfile).toContain('addgroup');
    expect(dockerfile).toContain('adduser');
    expect(dockerfile).not.toContain('useradd');
  });

  test('uses dnf for Fedora base image', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'fedora:latest',
      packages: ['git', 'curl'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('dnf install -y');
    expect(dockerfile).toContain('dnf clean all');
    expect(dockerfile).not.toContain('apt-get');
    expect(dockerfile).toContain('groupadd');
    expect(dockerfile).toContain('useradd');
  });

  test('explicit package_manager overrides auto-detection', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'node:slim',
      package_manager: 'apk',
      packages: ['git'],
    };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('apk add --no-cache');
    expect(dockerfile).not.toContain('apt-get');
  });

  test('throws when package manager cannot be detected', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'mycustomimage:latest',
      packages: ['git'],
    };

    expect(() => generateDockerfile(profile, [], noWraps))
      .toThrow(/Cannot detect package manager.*package_manager/);
  });

  test('runs apt install non-interactively', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).toContain('DEBIAN_FRONTEND=noninteractive apt-get install');
  });

  test('includes tzdata when listed as a package', () => {
    const profile: ContainerProfile = { ...baseProfile, packages: ['git', 'tzdata'] };
    const { dockerfile } = generateDockerfile(profile, [], noWraps);

    expect(dockerfile).toContain('tzdata');
  });

  test('python and oven/bun base images auto-detect apt', () => {
    const python: ContainerProfile = { ...baseProfile, base_image: 'python:3.12-slim' };
    const bun: ContainerProfile = { ...baseProfile, base_image: 'oven/bun:slim' };

    expect(generateDockerfile(python, [], noWraps).dockerfile).toContain('apt-get install');
    expect(generateDockerfile(bun, [], noWraps).dockerfile).toContain('apt-get install');
  });
});

describe('generateDockerfile sshd', () => {
  const sshdOpts = { ...noWraps, sshd: { authorizedKey: 'ssh-ed25519 AAAATESTKEY pi-tin' } };

  test('installs openssh-server and bakes launcher, authorized key, and config', () => {
    const { dockerfile, extras } = generateDockerfile(baseProfile, [], sshdOpts);

    expect(dockerfile).toContain('openssh-server');
    expect(dockerfile).toContain('COPY pi-tin-sshd-launch /usr/local/bin/pi-tin-sshd-launch');
    expect(dockerfile).toContain('COPY pi-tin-authorized-keys $HOME_DIR/.ssh/authorized_keys');
    expect(dockerfile).toContain('RUN chmod 600 $HOME_DIR/.ssh/authorized_keys');
    expect(dockerfile).toContain('COPY pi-tin-sshd-config $HOME_DIR/.config/pi-tin-sshd/sshd_config');

    const authorizedKeys = extras.find((extra) => extra.name === 'pi-tin-authorized-keys');
    expect(authorizedKeys?.content).toBe('ssh-ed25519 AAAATESTKEY pi-tin\n');

    const sshdConfig = extras.find((extra) => extra.name === 'pi-tin-sshd-config')?.content ?? '';
    expect(sshdConfig).toContain('Port 2222');
    expect(sshdConfig).toContain('UsePAM no');
    expect(sshdConfig).toContain('PasswordAuthentication no');
    expect(sshdConfig).toContain('PermitUserEnvironment yes');
    expect(sshdConfig).toContain('AllowUsers dev');
    expect(sshdConfig).toContain('HostKey /home/dev/.config/pi-tin-sshd/ssh_host_ed25519_key');

    const launcher = extras.find((extra) => extra.name === 'pi-tin-sshd-launch')?.content ?? '';
    expect(launcher).toContain('> "$HOME/.ssh/environment"');
    expect(launcher).toContain('exec /usr/sbin/sshd -D -e -f');
  });

  test('generates host keys as the user, after the USER switch', () => {
    const { dockerfile } = generateDockerfile(baseProfile, [], sshdOpts);

    const userIndex = dockerfile.indexOf('USER dev');
    const keygenIndex = dockerfile.indexOf('RUN ssh-keygen -q -t ed25519 -N ""');
    expect(userIndex).toBeGreaterThan(-1);
    expect(keygenIndex).toBeGreaterThan(userIndex);
  });

  test('adds .local/bin to PATH only when sshd is enabled', () => {
    const withSshd = generateDockerfile(baseProfile, [], sshdOpts).dockerfile;
    const withoutSshd = generateDockerfile(baseProfile, [], noWraps).dockerfile;

    expect(withSshd).toContain(':$HOME_DIR/.local/bin:$PATH');
    expect(withoutSshd).not.toContain('.local/bin');
  });

  test('sshd disabled leaves no sshd artifacts', () => {
    const { dockerfile, extras } = generateDockerfile(baseProfile, [], noWraps);

    expect(dockerfile).not.toContain('openssh-server');
    expect(dockerfile).not.toContain('ssh-keygen');
    expect(extras.map((extra) => extra.name)).toEqual([]);
  });

  test('installs openssh-server under apk and dnf too', () => {
    const alpine: ContainerProfile = { ...baseProfile, base_image: 'node:alpine' };
    const fedora: ContainerProfile = { ...baseProfile, base_image: 'fedora:latest' };

    expect(generateDockerfile(alpine, [], sshdOpts).dockerfile).toContain('openssh-server');
    expect(generateDockerfile(fedora, [], sshdOpts).dockerfile).toContain('openssh-server');
  });
});

describe('detectPackageManager', () => {
  test('detects each distro family', () => {
    expect(detectPackageManager('debian:trixie-slim')).toBe('apt');
    expect(detectPackageManager('ubuntu:24.04')).toBe('apt');
    expect(detectPackageManager('node:trixie-slim')).toBe('apt');
    expect(detectPackageManager('python:3.12-slim')).toBe('apt');
    expect(detectPackageManager('oven/bun:slim')).toBe('apt');
    expect(detectPackageManager('fedora:latest')).toBe('dnf');
    expect(detectPackageManager('rockylinux:9')).toBe('dnf');
    expect(detectPackageManager('node:alpine')).toBe('apk');
  });

  test('alpine wins over the Debian-based prefix', () => {
    expect(detectPackageManager('python:3.12-alpine')).toBe('apk');
    expect(detectPackageManager('oven/bun:alpine')).toBe('apk');
  });

  test('returns null for an unrecognised image name', () => {
    expect(detectPackageManager('mcr.microsoft.com/dotnet/sdk:9.0')).toBeNull();
    expect(detectPackageManager('mycustomimage:latest')).toBeNull();
  });

  test('Debian-family prefixes are anchored — no false positives on lookalikes', () => {
    // The added `python` / `oven/bun` entries must not match longer names that
    // merely start with those letters.
    expect(detectPackageManager('python-foo')).toBeNull();
    expect(detectPackageManager('oven/bunny')).toBeNull();
    expect(detectPackageManager('nodexyz:latest')).toBeNull();
  });
});
