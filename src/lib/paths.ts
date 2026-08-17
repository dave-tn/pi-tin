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

export function getAgentDefinitionsDir(): string {
  return path.join(getConfigDir(), 'agents');
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

/** Host directory for best-effort guest diagnostics (pre-stop dmesg snapshots). */
export function getDiagnosticsDir(): string {
  return path.join(getConfigDir(), 'diagnostics');
}

/** Per-workspace host directory mirroring the container's workspace state. */
export function getWorkspaceStateDir(workspaceName: string): string {
  return path.join(getConfigDir(), 'workspace-state', workspaceName);
}

export function getBuildHashPath(workspaceName: string): string {
  return path.join(getStateDir(), `${workspaceName}.hash`);
}

export function getUpdateCheckPath(): string {
  return path.join(getStateDir(), 'update-check.json');
}

/** pi-tin's ssh material: keypair, generated ssh config, per-workspace known_hosts. */
export function getSshDir(): string {
  return path.join(getConfigDir(), 'ssh');
}

export function getSshKeyPath(): string {
  return path.join(getSshDir(), 'id_ed25519');
}

export function getSshPublicKeyPath(): string {
  return path.join(getSshDir(), 'id_ed25519.pub');
}

/** The generated ssh config users Include from ~/.ssh/config. */
export function getSshConfigPath(): string {
  return path.join(getSshDir(), 'config');
}

export function getSshKnownHostsPath(workspaceName: string): string {
  return path.join(getSshDir(), `known_hosts.${workspaceName}`);
}

export function getUserSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
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

const YAML_SUFFIX = '.yaml';

/**
 * The stem a `<name>.yaml` write would fold onto, or undefined when the write is
 * safe. The invariant: a stem must be brand-new, or exactly the one already
 * there. macOS volumes are case-insensitive by default, so a rename of
 * `OMP.yaml` lands on an existing `omp.yaml` — replacing a different entity
 * while the on-disk name keeps its old spelling. Rejected on case-sensitive
 * volumes too: the loaders drop one of a folding pair as a name collision
 * anyway, so identical behaviour everywhere beats a platform-shaped footgun.
 */
export function findCaseFoldingStem(
  name: string,
  existingStems: readonly string[],
): string | undefined {
  if (existingStems.includes(name)) {
    return undefined;
  }
  return existingStems.find((stem) => stem.toLowerCase() === name.toLowerCase());
}

/**
 * `findCaseFoldingStem` over the `*.yaml` stems in `dir` (a missing directory
 * holds nothing, so the write is safe). The stems must come from a directory
 * read compared exactly: `fs.existsSync` of the target path folds case as well,
 * so it reports the exact stem as present for the very pair this rejects.
 */
export function findCaseFoldingStemOnDisk(name: string, dir: string): string | undefined {
  return findCaseFoldingStem(name, readYamlStems(dir));
}

/** Only files are loadable as definitions or profiles, matching the loaders. */
function readYamlStems(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(YAML_SUFFIX))
    .map((entry) => entry.name.slice(0, -YAML_SUFFIX.length));
}

export function caseFoldingNameMessage(
  entity: 'Agent definition' | 'Container profile',
  name: string,
  existingStem: string,
): string {
  return `${entity} '${name}' differs only by case from the existing '${existingStem}'; delete '${existingStem}' first, or choose another name.`;
}

/** Home directory of `user` inside a workspace container. */
export function containerHomeDir(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`;
}

/**
 * A container path in the canonical form the lexical mount comparisons expect:
 * redundant separators and `.`/`..` segments resolved, trailing slashes
 * dropped (`/` itself excepted). Guest paths are POSIX whatever the host is.
 * Config-supplied container paths (`host.mounts`) reach those comparisons
 * unvalidated, so they pass through here first.
 */
export function normalizeContainerPath(containerPath: string): string {
  const normalized = path.posix.normalize(containerPath);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * True when `childPath` equals `parentDir` or lies inside it. Both arguments
 * must already be normalised (e.g. via `path.resolve`) — no trailing
 * separators; the check is purely lexical, so `/a/bc` is not within `/a/b`.
 */
export function isWithinDir(childPath: string, parentDir: string): boolean {
  return childPath === parentDir || childPath.startsWith(parentDir + path.sep);
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
