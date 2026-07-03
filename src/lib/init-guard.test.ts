import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

import {
  ensureInitialised,
  syncDefaultContainerProfiles,
  DEFAULT_CONTAINER_PROFILES,
} from './init-guard.js';
import { validateContainerProfile } from './validators.js';
import { generateDockerfile } from './dockerfile.js';

describe('syncDefaultContainerProfiles', () => {
  let tmpDir: string;
  let firstName: string;
  let firstContent: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    const entries = Object.entries(DEFAULT_CONTAINER_PROFILES);
    const first = entries[0];
    if (first === undefined) throw new Error('DEFAULT_CONTAINER_PROFILES is empty');
    [firstName, firstContent] = first;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes missing default profiles', () => {
    const messages = syncDefaultContainerProfiles(tmpDir);

    for (const [name, content] of Object.entries(DEFAULT_CONTAINER_PROFILES)) {
      const filePath = path.join(tmpDir, `${name}.yaml`);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    }

    // No "updated" messages for fresh writes
    expect(messages).toEqual([]);
  });

  test('overwrites managed default profile when content differs', () => {
    const filePath = path.join(tmpDir, `${firstName}.yaml`);
    fs.writeFileSync(
      filePath,
      '# This profile is managed by pi-tin and will be overwritten on update.\n# Old content\n',
      'utf-8',
    );

    const messages = syncDefaultContainerProfiles(tmpDir);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe(firstContent);
    expect(messages).toContain(`Default profile '${firstName}' has been updated`);
  });

  test('does not overwrite user-edited default profile', () => {
    const profilePath = path.join(tmpDir, 'node-dev.yaml');
    fs.writeFileSync(profilePath, 'description: "My custom edit"\nbase_image: node:trixie-slim\n', 'utf-8');

    const messages = syncDefaultContainerProfiles(tmpDir);

    const content = fs.readFileSync(profilePath, 'utf-8');
    expect(content).toContain('My custom edit');
    expect(messages).toEqual([]);
  });

  test('overwrites managed default profile when content changes', () => {
    const profilePath = path.join(tmpDir, 'node-dev.yaml');
    fs.writeFileSync(
      profilePath,
      '# This profile is managed by pi-tin and will be overwritten on update.\n# Old content\n',
      'utf-8',
    );

    const messages = syncDefaultContainerProfiles(tmpDir);

    const content = fs.readFileSync(profilePath, 'utf-8');
    expect(content).toContain('node:trixie-slim');
    expect(messages.length).toBeGreaterThan(0);
  });

  test('skips write when content matches', () => {
    const filePath = path.join(tmpDir, `${firstName}.yaml`);
    fs.writeFileSync(filePath, firstContent, 'utf-8');

    const messages = syncDefaultContainerProfiles(tmpDir);

    expect(messages).toEqual([]);
  });

  test('leaves no temporary write artifacts in the profiles directory', () => {
    syncDefaultContainerProfiles(tmpDir);
    for (const entry of fs.readdirSync(tmpDir)) {
      expect(entry.endsWith('.yaml')).toBe(true);
    }
  });

  test('does not touch non-default profiles', () => {
    const customContent = 'description: "My custom profile"\n';
    const customPath = path.join(tmpDir, 'my-custom.yaml');
    fs.writeFileSync(customPath, customContent, 'utf-8');

    syncDefaultContainerProfiles(tmpDir);

    expect(fs.readFileSync(customPath, 'utf-8')).toBe(customContent);
  });

  test('default profiles parse as valid profiles', () => {
    for (const content of Object.values(DEFAULT_CONTAINER_PROFILES)) {
      expect(() => validateContainerProfile(YAML.parse(content))).not.toThrow();
    }
  });

  test('default profiles generate a Dockerfile without throwing', () => {
    const noWraps = { agentWraps: [], agentEnv: {}, claudeManagedSettings: null, claudeConfig: null };
    for (const content of Object.values(DEFAULT_CONTAINER_PROFILES)) {
      const profile = validateContainerProfile(YAML.parse(content));
      expect(() => generateDockerfile(profile, [], noWraps)).not.toThrow();
    }
  });

  test('every default profile installs zsh and sets it as the login shell', () => {
    for (const content of Object.values(DEFAULT_CONTAINER_PROFILES)) {
      const profile = validateContainerProfile(YAML.parse(content));
      // pi-tin enters via the user's login shell, so each managed profile must
      // install zsh and chsh to it in post_install for the baseline to apply.
      expect(profile.packages).toContain('zsh');
      expect(profile.post_install).toContain('chsh -s "$(command -v zsh)" "$USERNAME"');
    }
  });

  test('node-dev includes Playwright chromium default, UTF-8 locale, and tmux defaults', () => {
    const profile = DEFAULT_CONTAINER_PROFILES['node-dev'];
    if (profile === undefined) {
      throw new Error('node-dev profile missing');
    }

    expect(profile).toContain('PLAYWRIGHT_MCP_BROWSER: chromium');
    expect(profile).toContain('LANG: C.UTF-8');
    expect(profile).toContain('LC_ALL: C.UTF-8');
    expect(profile).toContain('/etc/tmux.conf');
    expect(profile).toContain('set -g default-terminal "tmux-256color"');
    expect(profile).toContain('set -g extended-keys on');
  });

  test('every default profile ships the common modern CLI toolset', () => {
    const expectedCommon = [
      'git', 'curl', 'jq', 'zsh', 'tmux', 'ca-certificates',
      'ripgrep', 'fd-find', 'bat', 'fzf', 'tree',
    ];
    for (const content of Object.values(DEFAULT_CONTAINER_PROFILES)) {
      const profile = validateContainerProfile(YAML.parse(content));
      const allPackages = [...profile.packages, ...profile.extra_packages];
      for (const pkg of expectedCommon) {
        expect(allPackages).toContain(pkg);
      }
    }
  });

  test('baseline post_install aliases the Debian-renamed fd and bat binaries', () => {
    for (const content of Object.values(DEFAULT_CONTAINER_PROFILES)) {
      const profile = validateContainerProfile(YAML.parse(content));
      const postInstall = profile.post_install.join('\n');
      expect(postInstall).toContain('alias fd=fdfind');
      expect(postInstall).toContain('alias bat=batcat');
    }
  });
});

describe('ensureInitialised', () => {
  let tmpDir: string;
  let configDir: string;
  let savedXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-test-'));
    configDir = path.join(tmpDir, 'pi-tin');
    savedXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = savedXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates config dir and subdirs on first run', () => {
    const { firstRun } = ensureInitialised();

    expect(firstRun).toBe(true);
    for (const subdir of ['profiles', 'workspaces', 'agent-profiles', 'tmux']) {
      expect(fs.existsSync(path.join(configDir, subdir))).toBe(true);
    }
  });

  test('reports firstRun false when the config dir already exists', () => {
    fs.mkdirSync(configDir, { recursive: true });

    const { firstRun } = ensureInitialised();

    expect(firstRun).toBe(false);
  });

  test('recreates missing subdirectories on subsequent runs', () => {
    ensureInitialised();
    fs.rmSync(path.join(configDir, 'workspaces'), { recursive: true, force: true });
    fs.rmSync(path.join(configDir, 'tmux'), { recursive: true, force: true });

    const { firstRun } = ensureInitialised();

    expect(firstRun).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'workspaces'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'tmux'))).toBe(true);
  });
});
