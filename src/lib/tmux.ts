import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTmuxConfigsDir } from './paths.js';

export function getHostTmuxConfigDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', 'tmux');
}

export function getHostTmuxConfigPath(homeDir: string = os.homedir()): string {
  return path.join(getHostTmuxConfigDir(homeDir), 'tmux.conf');
}

export function getLegacyHostTmuxConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.tmux.conf');
}

export function getHostTmuxPluginsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.tmux');
}

export function hostTmuxConfigExists(homeDir: string = os.homedir()): boolean {
  const configPath = getHostTmuxConfigPath(homeDir);
  return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
}

export function legacyHostTmuxConfigExists(homeDir: string = os.homedir()): boolean {
  const configPath = getLegacyHostTmuxConfigPath(homeDir);
  return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
}

export function hostTmuxPluginsDirExists(homeDir: string = os.homedir()): boolean {
  const dir = getHostTmuxPluginsDir(homeDir);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

export function moveLegacyHostTmuxConfig(homeDir: string = os.homedir()): string {
  const source = getLegacyHostTmuxConfigPath(homeDir);
  const destinationDir = getHostTmuxConfigDir(homeDir);
  const destination = getHostTmuxConfigPath(homeDir);

  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Legacy tmux config not found at ${source}`);
  }
  if (fs.existsSync(destination)) {
    throw new Error(`tmux config already exists at ${destination}`);
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  fs.renameSync(source, destination);
  return destination;
}

export function hostTmuxConfigUsesPluginsDir(homeDir: string = os.homedir()): boolean {
  if (!hostTmuxConfigExists(homeDir)) {
    return false;
  }
  return fs.readFileSync(getHostTmuxConfigPath(homeDir), 'utf-8').includes('.tmux/');
}

export function getWorkspaceTmuxDir(workspaceName: string): string {
  return path.join(getTmuxConfigsDir(), workspaceName);
}

export function ensureWorkspaceTmuxDir(workspaceName: string): string {
  const baseDir = getWorkspaceTmuxDir(workspaceName);
  const configDir = path.join(baseDir, '.config', 'tmux');
  const pluginsDir = path.join(baseDir, '.tmux');
  const configPath = path.join(configDir, 'tmux.conf');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      '# Workspace tmux config\n# Edit this file to customise tmux inside this workspace.\n',
      'utf-8',
    );
  }

  return baseDir;
}
