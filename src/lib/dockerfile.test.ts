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
};

const noWraps = { agentWraps: [], agentEnv: {}, claudeManagedSettings: null };

describe('generateDockerfile', () => {
  test('produces basic Dockerfile structure', () => {
    const { dockerfile, extras } = generateDockerfile(baseProfile, 'bash', [], noWraps);

    expect(dockerfile).toContain('FROM node:slim');
    expect(dockerfile).toContain('ARG USERNAME=dev');
    expect(dockerfile).toContain('WORKDIR /workspace');
    expect(dockerfile).toContain('CMD ["bash"]');
    expect(dockerfile).toContain('USER dev');
    expect(extras).toEqual([]);
  });

  test('includes apt packages', () => {
    const { dockerfile } = generateDockerfile(baseProfile, 'bash', [], noWraps);

    expect(dockerfile).toContain('apt-get install');
    expect(dockerfile).toContain('git');
    expect(dockerfile).toContain('curl');
  });

  test('quotes env values', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      env: { NODE_ENV: 'production', PATH_EXTRA: '/usr/local/bin' },
    };
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

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
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

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
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

    // Single RUN combines all global tools so npm parallelises fetches.
    expect(dockerfile).toContain('RUN npm install -g typescript@latest @playwright/cli@latest');
  });

  test('includes post-install commands', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      post_install: ['echo "done"'],
    };
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

    expect(dockerfile).toContain('RUN echo "done"');
  });

  test('post_setup commands run after global tools and USER switch', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      global_tools: ['@playwright/cli@latest'],
      post_setup: ['playwright-cli install-browser chromium'],
    };
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

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
    const { dockerfile, extras } = generateDockerfile(baseProfile, 'bash', packages, noWraps);

    expect(dockerfile).toContain('# Workspace packages');
    expect(dockerfile).not.toContain('USER root');
    expect(dockerfile).toContain('RUN npm install -g @anthropic-ai/claude-code@latest');
    expect(dockerfile).toContain('COPY pi-tin-entrypoint');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/pi-tin-entrypoint"]');
    expect(extras).toHaveLength(1);
    expect(extras[0]!.name).toBe('pi-tin-entrypoint');
    expect(extras[0]!.content).toContain('#!/bin/sh');
    expect(extras[0]!.content).toContain('npm install -g --fetch-timeout=60000 --fetch-retries=0 "@anthropic-ai/claude-code@latest"');
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
    const { extras, dockerfile } = generateDockerfile(baseProfile, 'bash', packages, {
      agentWraps: [],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1' },
      claudeManagedSettings,
    });

    const settingsFile = extras.find((extra) => extra.name === 'claude-managed-settings.json');
    expect(settingsFile?.content).toContain('"defaultMode": "bypassPermissions"');
    expect(settingsFile?.content).toContain('"enabled": false');
    expect(dockerfile).toContain('COPY claude-managed-settings.json /etc/claude-code/managed-settings.d/90-pi-tin-claude-settings.json');
  });

  test('entrypoint wraps agents with skip-permissions flags', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const { extras } = generateDockerfile(baseProfile, 'bash', packages, {
      agentWraps: [{ binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' }],
      agentEnv: {},
      claudeManagedSettings: null,
    });

    expect(extras[0]!.content).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('entrypoint refresh preserves original package specs', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Pinned Tool', package: 'typescript@5.9.3' },
    ];
    const { extras } = generateDockerfile(baseProfile, 'bash', packages, noWraps);

    expect(extras[0]!.content).toContain('npm install -g --fetch-timeout=60000 --fetch-retries=0 "@anthropic-ai/claude-code@latest" "typescript@5.9.3"');
    expect(extras[0]!.content).not.toContain('npm update -g');
  });

  test('entrypoint does not wrap agents when agentWraps is empty', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { extras } = generateDockerfile(baseProfile, 'bash', packages, noWraps);

    expect(extras[0]!.content).not.toContain('--dangerously-skip-permissions');
    expect(extras[0]!.content).toContain('then\n    :\n  else');
  });

  test('entrypoint wraps non-Claude agents while Claude uses managed settings', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Codex', package: '@openai/codex@latest' },
      { name: 'Amp', package: '@sourcegraph/amp@latest' },
    ];
    const claudeManagedSettings = JSON.stringify({
      permissions: {
        defaultMode: 'bypassPermissions',
      },
    }, null, 2);
    const { extras, dockerfile } = generateDockerfile(baseProfile, 'bash', packages, {
      agentWraps: [
        { binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' },
        { binary: 'amp', flag: '--dangerously-allow-all' },
      ],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1' },
      claudeManagedSettings,
    });

    const entrypoint = extras.find((extra) => extra.name === 'pi-tin-entrypoint')!.content;
    expect(entrypoint).not.toContain('which claude');
    expect(entrypoint).not.toContain('--dangerously-skip-permissions');
    expect(entrypoint).toContain('which codex');
    expect(entrypoint).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(entrypoint).toContain('which amp');
    expect(entrypoint).toContain('--dangerously-allow-all');
    expect(dockerfile).toContain('ENV CLAUDE_CODE_SANDBOXED="1"');
    expect(dockerfile).toContain('COPY claude-managed-settings.json /etc/claude-code/managed-settings.d/90-pi-tin-claude-settings.json');
  });

  test('agentEnv sets container env vars', () => {
    const packages: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
      { name: 'Gemini CLI', package: '@google/gemini-cli@latest' },
    ];
    const { dockerfile } = generateDockerfile(baseProfile, 'bash', packages, {
      agentWraps: [
        { binary: 'gemini', flag: '--yolo' },
      ],
      agentEnv: { CLAUDE_CODE_SANDBOXED: '1', NO_BROWSER: 'true' },
      claudeManagedSettings: null,
    });

    expect(dockerfile).toContain('ENV CLAUDE_CODE_SANDBOXED="1"');
    expect(dockerfile).toContain('ENV NO_BROWSER="true"');
  });

  test('empty agentEnv does not set agent-specific env vars', () => {
    const packages: Tool[] = [
      { name: 'Codex', package: '@openai/codex@latest' },
    ];
    const { dockerfile } = generateDockerfile(baseProfile, 'bash', packages, {
      agentWraps: [
        { binary: 'codex', flag: '--dangerously-bypass-approvals-and-sandbox' },
      ],
      agentEnv: {},
      claudeManagedSettings: null,
    });

    expect(dockerfile).not.toContain('CLAUDE_CODE_SANDBOXED');
    expect(dockerfile).not.toContain('NO_BROWSER');
    expect(dockerfile).not.toContain('claude.json');
  });

  test('empty agentWraps produces no wrapping in entrypoint', () => {
    const packages: Tool[] = [
      { name: 'Pi', package: '@earendil-works/pi-coding-agent@latest' },
    ];
    const { extras } = generateDockerfile(baseProfile, 'bash', packages, noWraps);

    const entrypoint = extras[0]!.content;
    expect(entrypoint).not.toContain('-real');
  });

  test('returns no extras when no packages', () => {
    const { extras } = generateDockerfile(baseProfile, 'bash', [], noWraps);
    expect(extras).toEqual([]);
  });

  test('uses zsh shell', () => {
    const { dockerfile } = generateDockerfile(baseProfile, 'zsh', [], noWraps);

    expect(dockerfile).toContain('$(which zsh)');
    expect(dockerfile).toContain('CMD ["zsh"]');
  });

  test('skips Claude onboarding only for the exact Claude Code package', () => {
    const exact: Tool[] = [
      { name: 'Claude Code', package: '@anthropic-ai/claude-code@latest' },
    ];
    const { dockerfile: withClaude } = generateDockerfile(baseProfile, 'bash', exact, noWraps);
    expect(withClaude).toContain('RUN echo \'{"hasCompletedOnboarding":true}\' > ~/.claude.json');

    const prefixOnly: Tool[] = [
      { name: 'Claude Code Extras', package: '@anthropic-ai/claude-code-extras@latest' },
    ];
    const { dockerfile: withoutClaude } = generateDockerfile(baseProfile, 'bash', prefixOnly, noWraps);
    expect(withoutClaude).not.toContain('hasCompletedOnboarding');
  });

  test('uses /root for root user home directory', () => {
    const rootProfile: ContainerProfile = {
      ...baseProfile,
      user: 'root',
    };
    const { dockerfile } = generateDockerfile(rootProfile, 'bash', [], noWraps);

    expect(dockerfile).toContain('ARG HOME_DIR=/root');
    expect(dockerfile).not.toContain('/home/root');
  });

  test('uses apk for Alpine base image', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'node:alpine',
      packages: ['git', 'curl'],
    };
    const { dockerfile } = generateDockerfile(profile, 'sh', [], noWraps);

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
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

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
    const { dockerfile } = generateDockerfile(profile, 'sh', [], noWraps);

    expect(dockerfile).toContain('apk add --no-cache');
    expect(dockerfile).not.toContain('apt-get');
  });

  test('throws when package manager cannot be detected', () => {
    const profile: ContainerProfile = {
      ...baseProfile,
      base_image: 'mycustomimage:latest',
      packages: ['git'],
    };

    expect(() => generateDockerfile(profile, 'bash', [], noWraps))
      .toThrow(/Cannot detect package manager.*package_manager/);
  });

  test('runs apt install non-interactively', () => {
    const { dockerfile } = generateDockerfile(baseProfile, 'bash', [], noWraps);

    expect(dockerfile).toContain('DEBIAN_FRONTEND=noninteractive apt-get install');
  });

  test('includes tzdata when listed as a package', () => {
    const profile: ContainerProfile = { ...baseProfile, packages: ['git', 'tzdata'] };
    const { dockerfile } = generateDockerfile(profile, 'bash', [], noWraps);

    expect(dockerfile).toContain('tzdata');
  });

  test('python and oven/bun base images auto-detect apt', () => {
    const python: ContainerProfile = { ...baseProfile, base_image: 'python:3.12-slim' };
    const bun: ContainerProfile = { ...baseProfile, base_image: 'oven/bun:slim' };

    expect(generateDockerfile(python, 'bash', [], noWraps).dockerfile).toContain('apt-get install');
    expect(generateDockerfile(bun, 'bash', [], noWraps).dockerfile).toContain('apt-get install');
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
