import { ensureInitialised } from '../lib/init-guard.js';
import {
  loadWorkspace,
  listWorkspaces,
  workspaceExists,
  isValidWorkspaceName,
  invalidWorkspaceNameMessage,
} from '../lib/workspaces.js';
import { printJson } from '../lib/cli-output.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import { notFoundWorkspaceError } from '../lib/workspace-errors.js';

export function registerWorkspaceShowCommand(
  program: import('commander').Command,
): void {
  program
    .command('show <name>')
    .description('Show a workspace definition')
    .option('--json', 'Output machine-readable JSON')
    .action((name: string, _opts: { json?: boolean }) => {
      ensureInitialised();

      if (!isValidWorkspaceName(name)) {
        throw new CliError(invalidWorkspaceNameMessage(name), EXIT.VALIDATION, {
          code: 'validation',
          badInput: name,
          remediation: 'Run `pi-tin list` to see available workspaces.',
        });
      }

      if (!workspaceExists(name)) {
        throw notFoundWorkspaceError(name, listWorkspaces().map((w) => w.name));
      }

      // A workspace has no separate human rendering, so output is JSON
      // regardless; --json is accepted for consistency with other `show`
      // commands.
      printJson(loadWorkspace(name));
    });
}
