import path from 'node:path';
import type { VolumeMount } from './container.js';

export const MAX_SHARED_DIRECTORIES = 22;

export function resolveProjectVolumes(projects: string[]): VolumeMount[] {
  return projects.map((projectPath) => ({
    host: projectPath,
    container: `/workspace/${path.basename(projectPath)}`,
  }));
}

export function countUniqueVolumeSources(volumes: VolumeMount[]): number {
  return new Set(volumes.map((volume) => volume.host)).size;
}

export function sharedDirectoryLimitMessage(
  workspaceName: string,
  sharedDirectoryCount: number,
): string {
  return [
    `Workspace '${workspaceName}' requires ${sharedDirectoryCount} shared host directories, but pi-tin currently supports up to ${MAX_SHARED_DIRECTORIES} per workspace start.`,
    'This conservative limit avoids Apple container startup failures with large mount sets.',
    'Projects, host mounts, agent profiles, tmux mounts, and GitHub CLI mounts all count.',
    'Each project counts separately.',
    'Reduce mounted directories or split the workspace.',
  ].join('\n');
}

export function basenameCollisionMessage(basename: string, colliding: string[]): string {
  return `Project basename collision '${basename}' between:\n  ${colliding.join('\n  ')}`;
}
