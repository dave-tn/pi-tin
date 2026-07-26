import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureWorkspaceTmuxDir,
  hostTmuxConfigExists,
  hostTmuxConfigUsesPluginsDir,
  hostTmuxPluginsDirExists,
  legacyHostTmuxConfigExists,
  moveLegacyHostTmuxConfig,
} from './tmux.js';

describe('ensureWorkspaceTmuxDir', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-tmux-'));
    originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates persistent workspace tmux directories and config file', () => {
    const dir = ensureWorkspaceTmuxDir('demo');

    expect(dir).toBe(path.join(tmpDir, 'pi-tin', 'tmux', 'demo'));
    expect(fs.existsSync(path.join(dir, '.config', 'tmux'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.tmux'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.config', 'tmux', 'tmux.conf'), 'utf-8')).toBe(
      '# Workspace tmux config\n# Edit this file to customise tmux inside this workspace.\n',
    );
  });

  test('leaves an edited workspace tmux config untouched on re-open', () => {
    const dir = ensureWorkspaceTmuxDir('demo');
    const configPath = path.join(dir, '.config', 'tmux', 'tmux.conf');
    fs.writeFileSync(configPath, 'set -g mouse on\n', 'utf-8');

    ensureWorkspaceTmuxDir('demo');

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('set -g mouse on\n');
  });
});

describe('host tmux config discovery', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-tmux-home-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('hostTmuxConfigExists only accepts a regular file at ~/.config/tmux/tmux.conf', () => {
    const configPath = path.join(homeDir, '.config', 'tmux', 'tmux.conf');

    expect(hostTmuxConfigExists(homeDir)).toBe(false);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'set -g mouse on\n', 'utf-8');
    expect(hostTmuxConfigExists(homeDir)).toBe(true);

    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    expect(hostTmuxConfigExists(homeDir)).toBe(false);
  });

  test('legacyHostTmuxConfigExists only accepts a regular file at ~/.tmux.conf', () => {
    const legacyPath = path.join(homeDir, '.tmux.conf');

    expect(legacyHostTmuxConfigExists(homeDir)).toBe(false);

    fs.writeFileSync(legacyPath, 'set -g mouse on\n', 'utf-8');
    expect(legacyHostTmuxConfigExists(homeDir)).toBe(true);

    fs.rmSync(legacyPath);
    fs.mkdirSync(legacyPath);
    expect(legacyHostTmuxConfigExists(homeDir)).toBe(false);
  });

  test('hostTmuxPluginsDirExists only accepts a directory at ~/.tmux', () => {
    const pluginsPath = path.join(homeDir, '.tmux');

    expect(hostTmuxPluginsDirExists(homeDir)).toBe(false);

    fs.writeFileSync(pluginsPath, 'not a directory\n', 'utf-8');
    expect(hostTmuxPluginsDirExists(homeDir)).toBe(false);

    fs.rmSync(pluginsPath);
    fs.mkdirSync(pluginsPath);
    expect(hostTmuxPluginsDirExists(homeDir)).toBe(true);
  });

  test('hostTmuxConfigUsesPluginsDir detects a tpm run-shell line', () => {
    const configPath = path.join(homeDir, '.config', 'tmux', 'tmux.conf');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    expect(hostTmuxConfigUsesPluginsDir(homeDir)).toBe(false);

    fs.writeFileSync(configPath, 'set -g mouse on\nset -g history-limit 50000\n', 'utf-8');
    expect(hostTmuxConfigUsesPluginsDir(homeDir)).toBe(false);

    fs.writeFileSync(configPath, 'set -g mouse on\nrun-shell ~/.tmux/plugins/tpm/tpm\n', 'utf-8');
    expect(hostTmuxConfigUsesPluginsDir(homeDir)).toBe(true);
  });
});

describe('moveLegacyHostTmuxConfig', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tin-tmux-home-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('moves the legacy config into the XDG location, creating the directory', () => {
    const legacyPath = path.join(homeDir, '.tmux.conf');
    const configPath = path.join(homeDir, '.config', 'tmux', 'tmux.conf');
    fs.writeFileSync(legacyPath, 'set -g mouse on\nset -g status off\n', 'utf-8');

    const destination = moveLegacyHostTmuxConfig(homeDir);

    expect(destination).toBe(configPath);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('set -g mouse on\nset -g status off\n');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  test('throws naming the legacy path when there is nothing to move', () => {
    expect(() => moveLegacyHostTmuxConfig(homeDir)).toThrow(
      `Legacy tmux config not found at ${path.join(homeDir, '.tmux.conf')}`,
    );
  });

  test('refuses to overwrite an existing config and leaves both files intact', () => {
    const legacyPath = path.join(homeDir, '.tmux.conf');
    const configPath = path.join(homeDir, '.config', 'tmux', 'tmux.conf');
    fs.writeFileSync(legacyPath, 'legacy config\n', 'utf-8');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'current config\n', 'utf-8');

    expect(() => moveLegacyHostTmuxConfig(homeDir)).toThrow(
      `tmux config already exists at ${configPath}`,
    );

    expect(fs.readFileSync(legacyPath, 'utf-8')).toBe('legacy config\n');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('current config\n');
  });
});
