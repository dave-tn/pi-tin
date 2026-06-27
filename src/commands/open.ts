import type { Command } from 'commander';
import chalk from 'chalk';
import { openWorkspace } from '../lib/open.js';
import { loadWorkspace } from '../lib/workspaces.js';
import { computeContainerWorkdir } from '../lib/workdir.js';

export function registerOpenCommand(program: Command): void {
  program
    .command('open <workspace>')
    .description('Start or join a workspace')
    .option('--build', 'Force rebuild the container image')
    .action(async (wsName: string, opts: { build?: boolean }, command: Command) => {
      try {
        const workspace = loadWorkspace(wsName);
        const workdir = computeContainerWorkdir(process.cwd(), workspace.projects);
        const build = opts.build === true || command.parent?.opts<{ build?: boolean }>().build === true;
        await openWorkspace(wsName, { ...opts, build, workdir });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(msg));
        process.exit(1);
      }
    });
}
