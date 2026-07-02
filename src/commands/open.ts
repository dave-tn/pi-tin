import type { Command } from 'commander';
import { openWorkspace } from '../lib/open.js';
import {
  loadWorkspace,
  listWorkspaces,
  workspaceExists,
  isValidWorkspaceName,
} from '../lib/workspaces.js';
import { notFoundWorkspaceError } from '../lib/workspace-errors.js';
import { computeContainerWorkdir } from '../lib/workdir.js';

export function registerOpenCommand(program: Command): void {
  program
    .command('open <workspace>')
    .description('Start or join a workspace')
    .option('--build', 'Force rebuild the container image')
    .action(async (wsName: string, opts: { build?: boolean }, command: Command) => {
      // Invalid-name, parse, and schema errors from loadWorkspace carry
      // instructive detail and surface as-is; only a genuinely missing
      // workspace maps to the documented NOT_FOUND contract.
      if (isValidWorkspaceName(wsName) && !workspaceExists(wsName)) {
        throw notFoundWorkspaceError(wsName, listWorkspaces().map((w) => w.name));
      }
      const workspace = loadWorkspace(wsName);
      const workdir = computeContainerWorkdir(process.cwd(), workspace.projects);
      const build = opts.build === true || command.parent?.opts<{ build?: boolean }>().build === true;
      await openWorkspace(wsName, { ...opts, build, workdir });
    });
}
