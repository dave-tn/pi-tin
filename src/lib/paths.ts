import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg ?? path.join(os.homedir(), '.config');
  return path.join(base, 'pi-tin');
}

export function getContainerProfilesDir(): string {
  return path.join(getConfigDir(), 'profiles');
}

export function getAgentProfilesDir(): string {
  return path.join(getConfigDir(), 'agent-profiles');
}

export function getTmuxConfigsDir(): string {
  return path.join(getConfigDir(), 'tmux');
}

export function getWorkspacesDir(): string {
  return path.join(getConfigDir(), 'workspaces');
}

export function getStateDir(): string {
  return path.join(getConfigDir(), 'state');
}

export function getBuildHashPath(workspaceName: string): string {
  return path.join(getStateDir(), `${workspaceName}.hash`);
}

export function getUpdateCheckPath(): string {
  return path.join(getStateDir(), 'update-check.json');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.yaml');
}

export function getHostGhConfigDir(): string {
  return path.join(os.homedir(), '.config', 'gh');
}

// Profile names (container profiles, agent profiles) have no charset rule —
// existing profiles may legitimately contain uppercase, dots, etc. — but a
// name interpolated into a config path must stay a single path segment so it
// cannot escape its parent directory.
export function isSafePathSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

export const SAFE_PATH_SEGMENT_RULE =
  "Names must not be '.' or '..', and must not contain '/' or '\\'.";

/** Home directory of `user` inside a workspace container. */
export function containerHomeDir(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`;
}

export function expandTilde(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === '~') {
    return os.homedir();
  }
  return p;
}

export function findProjectRoot(from: string): string {
  let current = path.resolve(from);
  const root = path.parse(current).root;

  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return path.resolve(from);
}
