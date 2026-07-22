import type { Command } from 'commander';
import { ensureInteractive } from '../lib/confirmation.js';
import { openWorkspace } from '../lib/open.js';
import {
  loadWorkspace,
  listWorkspaces,
  workspaceExists,
  isValidWorkspaceName,
} from '../lib/workspaces.js';
import { notFoundWorkspaceError } from '../lib/workspace-errors.js';
import { computeContainerWorkdir } from '../lib/workdir.js';
import { ATTACH_MODES, parseAttachMode, type Workspace } from '../lib/validators.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function parseAttachOption(value: string | undefined): Workspace['attach'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const attach = parseAttachMode(value);
  if (attach === null) {
    throw new CliError(`Invalid attach mode '${value}'.`, EXIT.VALIDATION, {
      code: 'usage',
      badInput: value,
      validValues: [...ATTACH_MODES],
      remediation: 'Pass --attach shell or --attach herdr.',
    });
  }
  return attach;
}

export function registerOpenCommand(program: Command): void {
  program
    .command('open <workspace>')
    .description('Start or join a workspace')
    .option('--build', 'Force rebuild the container image')
    .option('--attach <mode>', 'Attach mode for this open: shell or herdr')
    .action(async (wsName: string, opts: { build?: boolean; attach?: string }, command: Command) => {
      // Headless open would start the container and then die at the
      // interactive attach — refuse before any side effects.
      ensureInteractive({
        action: 'open a workspace',
        remediation:
          '`open` attaches an interactive session — there is no headless equivalent. Inspect with `pi-tin list` or `pi-tin show <name> --json`.',
      });
      const attach = parseAttachOption(opts.attach);
      // Invalid-name, parse, and schema errors from loadWorkspace carry
      // instructive detail and surface as-is; only a genuinely missing
      // workspace maps to the documented NOT_FOUND contract.
      if (isValidWorkspaceName(wsName) && !workspaceExists(wsName)) {
        throw notFoundWorkspaceError(wsName, listWorkspaces().map((w) => w.name));
      }
      const workspace = loadWorkspace(wsName);
      const workdir = computeContainerWorkdir(process.cwd(), workspace.projects);
      const build = opts.build === true || command.parent?.opts<{ build?: boolean }>().build === true;
      await openWorkspace(wsName, { build, workdir, attach });
    });
}
