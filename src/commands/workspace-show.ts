import { ensureInitialised } from '../lib/init-guard.js';
import { loadWorkspace, listWorkspaces, workspaceExists } from '../lib/workspaces.js';
import { printJson } from '../lib/cli-output.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerWorkspaceShowCommand(
  program: import('commander').Command,
): void {
  program
    .command('show <name>')
    .description('Show a workspace definition')
    .option('--json', 'Output machine-readable JSON')
    .action((name: string, _opts: { json?: boolean }) => {
      ensureInitialised();

      if (!workspaceExists(name)) {
        const available = listWorkspaces().map((w) => w.name);
        throw new CliError(
          available.length > 0
            ? `Workspace '${name}' not found. Available: ${available.join(', ')}`
            : `Workspace '${name}' not found — no workspaces configured.`,
          EXIT.NOT_FOUND,
          { code: 'not_found', badInput: name, validValues: available,
            remediation: 'Run `pi-tin list` to see available workspaces.' },
        );
      }

      // A workspace has no separate human rendering, so output is JSON
      // regardless; --json is accepted for consistency with other `show`
      // commands.
      printJson(loadWorkspace(name));
    });
}
