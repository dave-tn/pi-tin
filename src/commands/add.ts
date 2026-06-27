import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { ensureInitialised } from '../lib/init-guard.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { computeContainerWorkdir } from '../lib/workdir.js';
import { countSharedDirectories, openWorkspace } from '../lib/open.js';
import {
  appendProjectToWorkspace,
  findWorkspacesForDirectory,
  listWorkspaces,
  isValidWorkspaceName,
  invalidWorkspaceNameMessage,
} from '../lib/workspaces.js';
import { containerNameFor, getContainerState, type ContainerState } from '../lib/container.js';
import {
  addProjectToChosenWorkspace,
  addableWorkspaces,
  handleWorkspaceSelection,
  type WorkspaceMatch,
  type WorkspaceSelection,
} from '../lib/add-project.js';

type Logger = (...args: unknown[]) => void;
type SelectPrompt = (options: {
  message: string;
  choices: Array<{ name: string; value: WorkspaceSelection }>;
}) => Promise<WorkspaceSelection>;

export type AddCommandDeps = {
  ensureInitialised: () => void;
  cwd: () => string;
  withExitHandling: <T>(fn: () => Promise<T>) => Promise<T>;
  findWorkspacesForDirectory: (directory: string) => WorkspaceMatch[];
  listWorkspaces: () => WorkspaceMatch[];
  isValidWorkspaceName: (name: string) => boolean;
  select: SelectPrompt;
  runCreateFlow: (nameArg?: string) => Promise<void>;
  computeContainerWorkdir: (cwd: string, projects: string[]) => string | undefined;
  openWorkspace: (wsName: string, opts: { build?: boolean; workdir?: string | undefined }) => Promise<void> | void;
  countSharedDirectories: (wsName: string, projects: string[]) => number;
  getContainerStateFor: (wsName: string) => ContainerState;
  appendProjectToWorkspace: (wsName: string, projectPath: string) => void;
  log: Logger;
  error: Logger;
  exit: (code: number) => void;
};

const defaultDeps: AddCommandDeps = {
  ensureInitialised,
  cwd: () => process.cwd(),
  withExitHandling,
  findWorkspacesForDirectory,
  listWorkspaces,
  isValidWorkspaceName,
  select,
  runCreateFlow: async (nameArg?: string) => {
    const { runCreateFlow } = await import('./create.js');
    await runCreateFlow(nameArg);
  },
  computeContainerWorkdir,
  openWorkspace,
  countSharedDirectories,
  getContainerStateFor: (wsName: string) => getContainerState(containerNameFor(wsName)),
  appendProjectToWorkspace,
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  exit: (code: number) => {
    process.exit(code);
  },
};

export async function runAddCommand(
  workspaceArg: string | undefined,
  deps: AddCommandDeps = defaultDeps,
): Promise<void> {
  deps.ensureInitialised();
  const cwd = deps.cwd();

  await deps.withExitHandling(async () => {
    const alreadyCovering = deps.findWorkspacesForDirectory(cwd);
    const all = deps.listWorkspaces();

    if (workspaceArg !== undefined) {
      if (!deps.isValidWorkspaceName(workspaceArg)) {
        deps.error(chalk.red(invalidWorkspaceNameMessage(workspaceArg)));
        deps.exit(1);
        return;
      }
      const target = all.find((m) => m.name === workspaceArg);
      if (target === undefined) {
        const available = all.map((m) => m.name);
        const message = available.length > 0
          ? `Workspace '${workspaceArg}' not found. Available: ${available.join(', ')}`
          : `Workspace '${workspaceArg}' not found. No workspaces configured.`;
        deps.error(chalk.red(message));
        deps.exit(1);
        return;
      }
      if (alreadyCovering.some((m) => m.name === workspaceArg)) {
        deps.error(chalk.red(`This directory is already in workspace '${workspaceArg}'.`));
        deps.exit(1);
        return;
      }
      await addProjectToChosenWorkspace(target, cwd, deps);
      return;
    }

    if (all.length === 0) {
      await deps.runCreateFlow();
      return;
    }

    const addable = addableWorkspaces(all, alreadyCovering);
    const coveringNames = alreadyCovering.map((m) => m.name);

    if (addable.length === 0) {
      deps.log(`This directory is already in every workspace: ${coveringNames.join(', ')}.`);
      const choice = await deps.select({
        message: 'Create a new workspace?',
        choices: [
          { name: 'Create new workspace', value: { kind: 'create-new' as const } },
          { name: 'Cancel', value: { kind: 'cancel' as const } },
        ],
      });
      await handleWorkspaceSelection(choice, cwd, deps);
      return;
    }

    if (coveringNames.length > 0) {
      deps.log(`Already in: ${coveringNames.join(', ')}.`);
    }
    const choice = await deps.select({
      message: 'Add this directory to a workspace, or create a new one:',
      choices: [
        { name: 'Create new workspace', value: { kind: 'create-new' as const } },
        ...addable.map((m) => ({ name: m.name, value: { kind: 'add-to' as const, target: m } })),
        { name: 'Cancel', value: { kind: 'cancel' as const } },
      ],
    });
    await handleWorkspaceSelection(choice, cwd, deps);
  });
}

export function registerAddCommand(program: import('commander').Command): void {
  program
    .command('add [workspace]')
    .description('Add the current directory to a workspace, or create a new one')
    .action(async (workspace: string | undefined) => {
      await runAddCommand(workspace);
    });
}
