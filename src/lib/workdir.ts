import path from 'node:path';
import { isWithinDir } from './paths.js';

export function computeContainerWorkdir(
  cwd: string,
  projects: string[],
): string | undefined {
  const resolved = path.resolve(cwd);

  for (const projectPath of projects) {
    const resolvedProject = path.resolve(projectPath);
    if (!isWithinDir(resolved, resolvedProject)) {
      continue;
    }

    const base = `/workspace/${path.basename(resolvedProject)}`;
    return resolved === resolvedProject
      ? base
      : `${base}/${resolved.slice(resolvedProject.length + 1)}`;
  }

  return undefined;
}
