import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import {
  containerProfileExists,
  deleteContainerProfile,
  planContainerProfileDelete,
} from '../lib/profiles.js';
import { listWorkspaces } from '../lib/workspaces.js';
import { confirmDestructive } from '../lib/confirmation.js';
import { printJson, printProfileDeleteDryRun, shouldEmitJson } from '../lib/cli-output.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerContainerProfileDeleteCommand(
  group: import('commander').Command,
): void {
  group
    .command('delete <name>')
    .description('Delete a container profile')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Print what would be removed without deleting')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // Validate the name up front so an unsafe name returns a machine-readable
      // validation error (exit 2), consistent with `container-profile apply`,
      // instead of falling through to the generic exit-1 plaintext handler.
      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: name, remediation: SAFE_PATH_SEGMENT_RULE },
        );
      }

      // Existence check only — parsing here would rewrite a corrupt or
      // schema-invalid profile into "not found" and make it undeletable.
      if (!containerProfileExists(name)) {
        throw new CliError(`Container profile '${name}' not found.`, EXIT.NOT_FOUND, {
          code: 'not_found',
        });
      }

      const impact = planContainerProfileDelete({
        name,
        workspaces: listWorkspaces().map((w) => ({
          name: w.name,
          profile: w.workspace.profile,
        })),
      });

      const json = shouldEmitJson(opts.json);

      if (opts.dryRun === true) {
        if (json) {
          printJson({ ...impact, dryRun: true });
        } else {
          printProfileDeleteDryRun('container profile', impact);
        }
        return;
      }

      if (!json && impact.referencedBy.length > 0) {
        console.warn(
          chalk.yellow(`Warning: container profile '${name}' is referenced by workspace(s): ${impact.referencedBy.join(', ')}`),
        );
      }

      await withExitHandling(async () => {
        const proceed = await confirmDestructive({
          message: `Delete container profile '${name}'?`,
          action: `delete container profile '${name}'`,
          force: opts.force === true,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }

        deleteContainerProfile(name);

        if (json) {
          printJson({ action: 'deleted', profile: name });
        } else {
          console.log(chalk.green(`✔ Deleted container profile '${name}'`));
        }
      });
    });
}
