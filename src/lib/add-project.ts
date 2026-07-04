import chalk from 'chalk';
import { MAX_SHARED_DIRECTORIES } from './project-mounts.js';
import { planAddProject } from './workspace-plans.js';
import type { ContainerState } from './container.js';
import type { Workspace } from './validators.js';

type Logger = (...args: unknown[]) => void;

export type WorkspaceMatch = {
  name: string;
  workspace: Workspace;
};

// Inquirer renders `name` only; the value carries the decision (and the
// matched workspace, so no re-lookup by name is needed).
export type WorkspaceSelection =
  | { kind: 'open'; match: WorkspaceMatch }
  | { kind: 'create-new' }
  | { kind: 'add-to'; target: WorkspaceMatch }
  | { kind: 'cancel' };

export type AddExecutorDeps = {
  countSharedDirectories: (wsName: string, projects: string[]) => number;
  getContainerStateFor: (wsName: string) => ContainerState;
  appendProjectToWorkspace: (wsName: string, projectPath: string) => void;
  computeContainerWorkdir: (cwd: string, projects: string[]) => string | undefined;
  openWorkspace: (wsName: string, opts: { build?: boolean; workdir?: string | undefined }) => Promise<void> | void;
  log: Logger;
  error: Logger;
  exit: (code: number) => void;
};

export type WorkspaceSelectionDeps = AddExecutorDeps & {
  runCreateFlow: (nameArg?: string) => Promise<void>;
};

export function handleActionError(
  err: unknown,
  deps: Pick<AddExecutorDeps, 'error' | 'exit'>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.error(chalk.red(message));
  deps.exit(1);
}

export function addableWorkspaces(
  all: WorkspaceMatch[],
  alreadyCovering: WorkspaceMatch[],
): WorkspaceMatch[] {
  const coveredNames = new Set(alreadyCovering.map((m) => m.name));
  return all.filter((m) => !coveredNames.has(m.name));
}

export async function addProjectToChosenWorkspace(
  target: WorkspaceMatch,
  cwd: string,
  deps: AddExecutorDeps,
): Promise<void> {
  try {
    const candidateProjects = [...target.workspace.projects, cwd];
    const plan = planAddProject({
      projectPath: cwd,
      workspaceName: target.name,
      existingProjects: target.workspace.projects,
      projectedSharedDirectoryCount: deps.countSharedDirectories(target.name, candidateProjects),
      maxSharedDirectories: MAX_SHARED_DIRECTORIES,
      containerState: deps.getContainerStateFor(target.name),
    });

    switch (plan.action) {
      case 'reject':
        deps.error(chalk.red(plan.message));
        deps.exit(1);
        return;
      case 'add-and-message':
        deps.appendProjectToWorkspace(target.name, cwd);
        deps.log(plan.message);
        return;
      case 'add-and-open': {
        deps.appendProjectToWorkspace(target.name, cwd);
        deps.log(chalk.green(`Added ${cwd} to workspace '${target.name}'.`));
        const workdir = deps.computeContainerWorkdir(cwd, candidateProjects);
        await deps.openWorkspace(target.name, { build: false, workdir });
        return;
      }
      default: {
        const _exhaustive: never = plan;
        throw new Error(`Unhandled add-project action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    handleActionError(err, deps);
  }
}

export async function handleWorkspaceSelection(
  choice: WorkspaceSelection,
  cwd: string,
  deps: WorkspaceSelectionDeps,
): Promise<void> {
  switch (choice.kind) {
    case 'create-new':
      await deps.runCreateFlow();
      return;
    case 'cancel':
      deps.log(`To create a workspace: ${chalk.cyan('pi-tin create <name>')}`);
      deps.log(`For help: ${chalk.cyan('pi-tin --help')}`);
      return;
    case 'add-to':
      await addProjectToChosenWorkspace(choice.target, cwd, deps);
      return;
    case 'open':
      // 'open' is produced only by default-action's multi-match menu, which
      // handles it inline; the add-style menus never offer it.
      return;
    default: {
      const _exhaustive: never = choice;
      throw new Error(`Unhandled workspace selection: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
