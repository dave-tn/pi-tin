import path from 'node:path';

export function computeContainerWorkdir(
  cwd: string,
  projects: string[],
): string | undefined {
  const resolved = path.resolve(cwd);

  for (const projectPath of projects) {
    const resolvedProject = path.resolve(projectPath);

    if (resolved === resolvedProject) {
      return `/workspace/${path.basename(resolvedProject)}`;
    }

    if (resolved.startsWith(resolvedProject + path.sep)) {
      const relative = resolved.slice(resolvedProject.length + 1);
      return `/workspace/${path.basename(resolvedProject)}/${relative}`;
    }
  }

  return undefined;
}
