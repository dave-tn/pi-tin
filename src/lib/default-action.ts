import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { ensureInitialised } from './init-guard.js';
import { countSharedDirectories, openWorkspace } from './open.js';
import { appendProjectToWorkspace, findWorkspacesForDirectory, listWorkspaces } from './workspaces.js';
import { containerNameFor, getContainerState, type ContainerState } from './container.js';
import { withExitHandling } from './exit-handling.js';
import { ensureInteractive, isInteractiveSession } from './confirmation.js';
import { computeContainerWorkdir } from './workdir.js';
import {
  handleActionError,
  handleWorkspaceSelection,
  type WorkspaceMatch,
  type WorkspaceSelection,
} from './add-project.js';

export type { WorkspaceSelection };

const ensureDefaultActionInteractive = (): void =>
  ensureInteractive({
    action: 'choose a workspace interactively',
    remediation:
      'Run an explicit command instead: `pi-tin list`, `pi-tin open <workspace>`, or see `pi-tin agent-guide`.',
  });

type Logger = (...args: unknown[]) => void;
type ConfirmPrompt = (options: { message: string; default?: boolean }) => Promise<boolean>;
type SelectPrompt = (options: {
  message: string;
  choices: Array<{ name: string; value: WorkspaceSelection }>;
}) => Promise<WorkspaceSelection>;
type RunCreateFlow = (nameArg?: string) => Promise<void>;
type ExitHandling = <T>(fn: () => Promise<T>) => Promise<T>;

export type DefaultActionDeps = {
  ensureInitialised: () => void;
  ensureInteractive: () => void;
  cwd: () => string;
  findWorkspacesForDirectory: (directory: string) => WorkspaceMatch[];
  confirm: ConfirmPrompt;
  select: SelectPrompt;
  runCreateFlow: RunCreateFlow;
  computeContainerWorkdir: (cwd: string, projects: string[]) => string | undefined;
  openWorkspace: (wsName: string, opts: { build?: boolean; workdir?: string | undefined }) => Promise<void> | void;
  withExitHandling: ExitHandling;
  log: Logger;
  error: Logger;
  exit: (code: number) => void;
  listWorkspaces: () => WorkspaceMatch[];
  getContainerStateFor: (wsName: string) => ContainerState;
  isInteractiveSession: () => boolean;
  appendProjectToWorkspace: (wsName: string, projectPath: string) => void;
  countSharedDirectories: (wsName: string, projects: string[]) => number;
};

const defaultDeps: DefaultActionDeps = {
  ensureInitialised,
  ensureInteractive: ensureDefaultActionInteractive,
  cwd: () => process.cwd(),
  findWorkspacesForDirectory,
  confirm,
  select,
  runCreateFlow: async (nameArg?: string) => {
    const { runCreateFlow } = await import('../commands/create.js');
    await runCreateFlow(nameArg);
  },
  computeContainerWorkdir,
  openWorkspace,
  withExitHandling,
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  exit: (code: number) => {
    process.exit(code);
  },
  listWorkspaces,
  getContainerStateFor: (wsName: string) => getContainerState(containerNameFor(wsName)),
  isInteractiveSession,
  appendProjectToWorkspace,
  countSharedDirectories,
};

async function openMatchedWorkspace(
  match: WorkspaceMatch,
  cwd: string,
  build: boolean,
  deps: Pick<DefaultActionDeps, 'computeContainerWorkdir' | 'openWorkspace' | 'error' | 'exit'>,
): Promise<void> {
  try {
    const workdir = deps.computeContainerWorkdir(cwd, match.workspace.projects);
    await deps.openWorkspace(match.name, { build, workdir });
  } catch (err) {
    handleActionError(err, deps);
  }
}

export async function runDefaultAction(
  opts: { build?: boolean },
  deps: DefaultActionDeps = defaultDeps,
): Promise<void> {
  deps.ensureInteractive();
  deps.ensureInitialised();

  const cwd = deps.cwd();
  const matches = deps.findWorkspacesForDirectory(cwd);
  const build = opts.build === true;

  await deps.withExitHandling(async () => {
    if (matches.length === 0) {
      const existing = deps.listWorkspaces();
      if (existing.length === 0) {
        const shouldCreate = await deps.confirm({
          message: 'No workspaces include this directory. Create one?',
          default: true,
        });
        if (shouldCreate) {
          await deps.runCreateFlow();
        } else {
          deps.log(`To create a workspace: ${chalk.cyan('pi-tin create <name>')}`);
          deps.log(`For help: ${chalk.cyan('pi-tin --help')}`);
        }
        return;
      }

      const choice = await deps.select({
        message: 'No workspace includes this directory. Add it to one, or create a new workspace?',
        choices: [
          { name: 'Create new workspace', value: { kind: 'create-new' as const } },
          ...existing.map((match) => ({ name: match.name, value: { kind: 'add-to' as const, target: match } })),
          { name: 'Cancel', value: { kind: 'cancel' as const } },
        ],
      });

      await handleWorkspaceSelection(choice, cwd, deps);
      return;
    }

    if (matches.length === 1) {
      const match = matches[0];
      if (!match) {
        handleActionError(new Error('Expected one matching workspace.'), deps);
        return;
      }
      await openMatchedWorkspace(match, cwd, build, deps);
      return;
    }

    const choice = await deps.select({
      message: 'Multiple workspaces match this directory:',
      choices: [
        ...matches.map((match) => ({ name: match.name, value: { kind: 'open' as const, match } })),
        { name: 'Create new workspace', value: { kind: 'create-new' as const } },
      ],
    });

    if (choice.kind === 'open') {
      await openMatchedWorkspace(choice.match, cwd, build, deps);
      return;
    }
    if (choice.kind === 'create-new') {
      await deps.runCreateFlow();
      return;
    }
  });
}
