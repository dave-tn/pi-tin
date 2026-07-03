import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getWorkspacesDir, isWithinDir } from './paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { parseYaml } from './yaml.js';
import { validateWorkspace } from './validators.js';
import type { Workspace } from './validators.js';

export function loadWorkspace(name: string): Workspace {
  assertValidWorkspaceName(name);
  const wsPath = path.join(getWorkspacesDir(), `${name}.yaml`);
  if (!fs.existsSync(wsPath)) {
    throw new Error(
      `Workspace '${name}' not found at ${wsPath}\nRun 'pi-tin list' to see available workspaces.`,
    );
  }
  const raw: unknown = parseYaml(fs.readFileSync(wsPath, 'utf-8'), wsPath);
  return validateWorkspace(raw);
}

export function listWorkspaces(): Array<{ name: string; workspace: Workspace }> {
  const dir = getWorkspacesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const name = f.replace(/\.yaml$/, '');
      try {
        const workspace = loadWorkspace(name);
        return { name, workspace };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: skipping invalid workspace '${name}': ${message}`);
        return undefined;
      }
    })
    .filter((entry): entry is { name: string; workspace: Workspace } => entry !== undefined);
}

const workspaceNamePattern = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidWorkspaceName(name: string): boolean {
  return workspaceNamePattern.test(name);
}

export const WORKSPACE_NAME_RULE =
  "Names must be lowercase alphanumeric, and may contain '.', '-', or '_'. Must start with a letter or digit.";

export function invalidWorkspaceNameMessage(name: string): string {
  return `Invalid workspace name '${name}'. ${WORKSPACE_NAME_RULE}`;
}

// Guard for any code path that derives filesystem or container names from a
// raw workspace name without going through loadWorkspace (e.g. stop/delete).
export function assertValidWorkspaceName(name: string): void {
  if (!isValidWorkspaceName(name)) {
    throw new Error(invalidWorkspaceNameMessage(name));
  }
}

export function writeWorkspace(name: string, workspace: Workspace): void {
  assertValidWorkspaceName(name);
  const wsPath = path.join(getWorkspacesDir(), `${name}.yaml`);
  atomicWriteFile(wsPath, YAML.stringify(workspace));
}

export function appendProjectToWorkspace(name: string, projectPath: string): void {
  assertValidWorkspaceName(name);
  const wsPath = path.join(getWorkspacesDir(), `${name}.yaml`);
  if (!fs.existsSync(wsPath)) {
    throw new Error(
      `Workspace '${name}' not found at ${wsPath}\nRun 'pi-tin list' to see available workspaces.`,
    );
  }
  const doc = YAML.parseDocument(fs.readFileSync(wsPath, 'utf-8'));
  const seq = doc.get('projects', true);
  if (YAML.isSeq(seq)) {
    seq.add(projectPath);
  } else {
    doc.set('projects', [projectPath]);
  }
  atomicWriteFile(wsPath, String(doc));
}

export function workspaceExists(name: string): boolean {
  return fs.existsSync(path.join(getWorkspacesDir(), `${name}.yaml`));
}

export function deleteWorkspace(name: string): void {
  assertValidWorkspaceName(name);
  const wsPath = path.join(getWorkspacesDir(), `${name}.yaml`);
  if (!fs.existsSync(wsPath)) {
    throw new Error(
      `Workspace '${name}' not found.\nRun 'pi-tin list' to see available workspaces.`,
    );
  }
  fs.unlinkSync(wsPath);
}

export function findWorkspacesForDirectory(
  directory: string,
): Array<{ name: string; workspace: Workspace }> {
  const resolved = path.resolve(directory);
  return listWorkspaces().filter(({ workspace }) =>
    workspace.projects.some((projectPath) => isWithinDir(resolved, path.resolve(projectPath))),
  );
}
