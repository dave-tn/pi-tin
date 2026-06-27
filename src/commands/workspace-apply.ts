import { ensureInitialised } from '../lib/init-guard.js';
import {
  loadWorkspace,
  writeWorkspace,
  workspaceExists,
  isValidWorkspaceName,
  invalidWorkspaceNameMessage,
} from '../lib/workspaces.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import { validateWorkspace } from '../lib/validators.js';
import type { Workspace } from '../lib/validators.js';
import { readStdin } from '../lib/stdin.js';
import { parseJsonInput, toValidationError } from '../lib/apply-input.js';
import { diffJson } from '../lib/json-diff.js';
import { printJson } from '../lib/cli-output.js';

export function registerWorkspaceApplyCommand(
  program: import('commander').Command,
): void {
  program
    .command('apply <name>')
    .description('Create or update a workspace from a JSON object on stdin')
    .option('--dry-run', 'Print the diff without writing')
    .option('--json', 'Output machine-readable JSON (always JSON; accepted for consistency)')
    .action(async (name: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      if (!isValidWorkspaceName(name)) {
        throw new CliError(invalidWorkspaceNameMessage(name), EXIT.VALIDATION, {
          code: 'validation',
          badInput: name,
          remediation: 'Choose a valid workspace name.',
        });
      }

      const raw = parseJsonInput(await readStdin());
      const workspace = parseWorkspace(raw);

      const exists = workspaceExists(name);
      const before = exists ? loadWorkspace(name) : {};
      const changes = diffJson(before, workspace);

      if (opts.dryRun === true) {
        printJson({ action: exists ? 'update' : 'create', name, dryRun: true, changes });
        return;
      }

      writeWorkspace(name, workspace);
      printJson({ action: exists ? 'updated' : 'created', name, changes });
    });
}

function parseWorkspace(raw: unknown): Workspace {
  try {
    return validateWorkspace(raw);
  } catch (err) {
    throw toValidationError(err, 'pi-tin show <name> --json');
  }
}
