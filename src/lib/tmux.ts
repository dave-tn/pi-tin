import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTmuxConfigsDir } from './paths.js';

export function getHostTmuxConfigDir(): string {
  return path.join(os.homedir(), '.config', 'tmux');
}

export function getHostTmuxConfigPath(): string {
  return path.join(getHostTmuxConfigDir(), 'tmux.conf');
}

export function getLegacyHostTmuxConfigPath(): string {
  return path.join(os.homedir(), '.tmux.conf');
}

export function getHostTmuxPluginsDir(): string {
  return path.join(os.homedir(), '.tmux');
}

export function hostTmuxConfigExists(): boolean {
  const configPath = getHostTmuxConfigPath();
  return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
}

export function legacyHostTmuxConfigExists(): boolean {
  const configPath = getLegacyHostTmuxConfigPath();
  return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
}

export function hostTmuxPluginsDirExists(): boolean {
  const dir = getHostTmuxPluginsDir();
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

export function moveLegacyHostTmuxConfig(): string {
  const source = getLegacyHostTmuxConfigPath();
  const destinationDir = getHostTmuxConfigDir();
  const destination = getHostTmuxConfigPath();

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

export function hostTmuxConfigUsesPluginsDir(): boolean {
  if (!hostTmuxConfigExists()) {
    return false;
  }
  return fs.readFileSync(getHostTmuxConfigPath(), 'utf-8').includes('.tmux/');
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
