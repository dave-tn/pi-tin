import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import {
  agentProfileExists,
  deleteAgentProfile,
  planAgentProfileDelete,
  type AgentProfileDeleteImpact,
} from '../lib/agent-profiles.js';
import { listWorkspaces } from '../lib/workspaces.js';
import { confirmDestructive } from '../lib/confirmation.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentProfileDeleteCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('delete <name>')
    .description('Delete an agent profile')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Print what would be removed without deleting')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // Validate the name up front so an unsafe name returns a machine-readable
      // validation error (exit 2), consistent with the apply commands, instead
      // of falling through to the generic exit-1 plaintext handler.
      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid agent profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: name, remediation: SAFE_PATH_SEGMENT_RULE },
        );
      }

      // Existence check only — parsing here would rewrite a corrupt
      // profile.yaml into "not found" and make the profile undeletable.
      if (!agentProfileExists(name)) {
        throw new CliError(`Agent profile '${name}' not found.`, EXIT.NOT_FOUND, {
          code: 'not_found',
        });
      }

      const impact = planAgentProfileDelete({
        name,
        workspaces: listWorkspaces().map((w) => ({
          name: w.name,
          agentProfiles: w.workspace.agent?.profiles ?? [],
        })),
      });

      const json = shouldEmitJson(opts.json);

      if (opts.dryRun === true) {
        if (json) {
          printJson({ ...impact, dryRun: true });
        } else {
          printDryRunHuman(impact);
        }
        return;
      }

      if (!json && impact.referencedBy.length > 0) {
        console.warn(
          chalk.yellow(`Warning: agent profile '${name}' is referenced by workspace(s): ${impact.referencedBy.join(', ')}`),
        );
      }

      await withExitHandling(async () => {
        const proceed = await confirmDestructive({
          message: `Delete agent profile '${name}'? This will remove all stored credentials and config.`,
          action: `delete agent profile '${name}'`,
          force: opts.force === true,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }

        deleteAgentProfile(name);

        if (json) {
          printJson({ action: 'deleted', profile: name });
        } else {
          console.log(chalk.green(`✔ Deleted agent profile '${name}'`));
        }
      });
    });
}

function printDryRunHuman(impact: AgentProfileDeleteImpact): void {
  console.log(`Would delete agent profile '${impact.profile}' (${impact.removes}).`);
  if (impact.referencedBy.length > 0) {
    console.log(chalk.yellow(`  Referenced by workspace(s): ${impact.referencedBy.join(', ')}`));
  }
}
