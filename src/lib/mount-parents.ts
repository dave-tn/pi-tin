import path from 'node:path';
import chalk from 'chalk';
import type { ContainerSubprocessRunner, VolumeMount } from './container.js';
import { execContainerCommand } from './container.js';

// Apple `container run` creates any missing mount-point ancestors inside the
// guest as root (mounting at ~/.nuget/packages leaves a root-owned ~/.nuget),
// so the workspace user cannot write next to the mount. The planner derives
// the ancestors to hand back; the executor chowns them — non-recursively, so
// mount contents and siblings are never touched — right after a fresh start.
// Scope is limited to ancestors under the container home: those are always
// the workspace user's by contract (the image chowns the whole home), whereas
// ancestors elsewhere may be deliberately root-owned system paths.

export function planMountParentChown(
  volumes: Array<Pick<VolumeMount, 'container'>>,
  homeContainer: string,
): string[] {
  const containerPaths = volumes.map((volume) => normalizeContainerPath(volume.container));
  const mountTargets = new Set(containerPaths);
  const homePrefix = `${homeContainer}/`;

  const parents = containerPaths
    .filter((containerPath) => containerPath.startsWith(homePrefix))
    .flatMap((containerPath) => ancestorsBetween(homeContainer, containerPath))
    .filter((ancestor) => !mountTargets.has(ancestor));

  return [...new Set(parents)].sort();
}

export function chownMountParents(options: {
  containerName: string;
  user: string;
  parentDirs: string[];
  run?: ContainerSubprocessRunner | undefined;
  warn?: ((message: string) => void) | undefined;
}): void {
  if (options.parentDirs.length === 0) return;

  try {
    execContainerCommand({
      name: options.containerName,
      user: 'root',
      command: ['chown', `${options.user}:${options.user}`, ...options.parentDirs],
      run: options.run,
    });
  } catch {
    const warn = options.warn ?? defaultWarn;
    warn(`Warning: could not reset ownership of mount parent directories (${options.parentDirs.join(', ')}) — writes beside these mounts may fail.`);
  }
}

function normalizeContainerPath(containerPath: string): string {
  const normalized = path.posix.normalize(containerPath);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function ancestorsBetween(homeContainer: string, containerPath: string): string[] {
  const ancestors: string[] = [];
  let dir = path.posix.dirname(containerPath);
  while (dir !== homeContainer && dir !== '/') {
    ancestors.push(dir);
    dir = path.posix.dirname(dir);
  }
  return ancestors;
}

function defaultWarn(message: string): void {
  console.warn(chalk.yellow(message));
}
