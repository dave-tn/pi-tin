import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import {
  agentDefinitionExists,
  deleteAgentDefinition,
  loadAgentDefinition,
  planAgentDelete,
} from '../lib/agent-definitions.js';
import type { AgentDeleteImpact } from '../lib/agent-definitions.js';
import { findBuiltInByName } from '../lib/agents.js';
import { listWorkspaces } from '../lib/workspaces.js';
import { listAgentProfiles } from '../lib/agent-profiles.js';
import { confirmDestructive } from '../lib/confirmation.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentDeleteCommand(group: import('commander').Command): void {
  group
    .command('delete <name>')
    .description('Delete a custom agent definition (built-ins cannot be deleted)')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Print what would be removed without deleting')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // Validate the name up front so an unsafe name returns a machine-readable
      // validation error (exit 2), consistent with `agent apply`, instead of
      // falling through to the generic exit-1 plaintext handler.
      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid agent definition name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: name, remediation: SAFE_PATH_SEGMENT_RULE },
        );
      }

      // Existence first, and existence only: a file on disk is a custom
      // definition by construction, so it stays deletable even when its name
      // shadows a built-in or its YAML is corrupt (parsing here would rewrite
      // a broken definition into "not found" and make it undeletable). Only
      // with nothing on disk does a built-in name explain the refusal.
      if (!agentDefinitionExists(name)) {
        if (findBuiltInByName(name) !== undefined) {
          throw new CliError(
            `Built-in agent '${name}' cannot be deleted; it is part of pi-tin.`,
            EXIT.VALIDATION,
            { code: 'validation', badInput: name },
          );
        }
        throw new CliError(`Agent definition '${name}' not found.`, EXIT.NOT_FOUND, {
          code: 'not_found',
        });
      }

      const definitionPackage = readPackage(name);
      const unreadable = definitionPackage === undefined;

      const workspaces = listWorkspaces().map((w) => ({
        name: w.name,
        tools: (w.workspace.tools ?? []).map((tool) => ({ package: tool.package })),
      }));
      const allAgentProfiles = listAgentProfiles().map((profile) => ({
        name: profile.name,
        agent: profile.agent,
      }));

      // The package key is omitted rather than passed as undefined: its absence
      // is what tells the planner workspace references are not checkable.
      const impact = planAgentDelete(
        definitionPackage === undefined
          ? { name, workspaces, allAgentProfiles }
          : { name, package: definitionPackage, workspaces, allAgentProfiles },
      );

      const json = shouldEmitJson(opts.json);

      if (opts.dryRun === true) {
        if (json) {
          printJson({
            name: impact.name,
            referencedBy: impact.referencedBy,
            agentProfiles: impact.agentProfiles,
            dryRun: true,
          });
        } else {
          printAgentDeleteDryRun(impact, unreadable);
        }
        return;
      }

      // Both warnings land before the prompt: they are what the user is being
      // asked to weigh. In JSON mode the caller already has the dry run.
      if (!json && impact.referencedBy.length > 0) {
        console.warn(
          chalk.yellow(`Warning: agent definition '${name}' is referenced by workspace(s): ${impact.referencedBy.join(', ')}`),
        );
      }

      if (!json && unreadable) {
        console.warn(
          chalk.yellow('Warning: definition unreadable; workspace references not checked.'),
        );
      }

      await withExitHandling(async () => {
        const proceed = await confirmDestructive({
          message: `Delete agent definition '${name}'?`,
          action: `delete agent definition '${name}'`,
          force: opts.force === true,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }

        deleteAgentDefinition(name);

        if (json) {
          printJson({ action: 'deleted', definition: name });
        } else {
          console.log(chalk.green(`✔ Deleted agent definition '${name}'`));
        }
      });
    });
}

// The install package is only knowable from a parseable definition, and a
// corrupt one must still be deletable — so a failed read degrades the impact
// report instead of aborting the delete.
function readPackage(name: string): string | undefined {
  try {
    return loadAgentDefinition(name).package;
  } catch {
    return undefined;
  }
}

// Own printer rather than the shared profile one: an agent definition's blast
// radius has two lists (workspaces installing its package, agent profiles
// claiming its name) and a caveat the profile shape has no room for.
function printAgentDeleteDryRun(impact: AgentDeleteImpact, unreadable: boolean): void {
  console.log(`Would delete agent definition '${impact.name}'.`);
  if (impact.referencedBy.length > 0) {
    console.log(chalk.yellow(`  Referenced by workspace(s): ${impact.referencedBy.join(', ')}`));
  }
  if (impact.agentProfiles.length > 0) {
    console.log(chalk.yellow(`  Agent profile(s): ${impact.agentProfiles.join(', ')}`));
  }
  if (unreadable) {
    console.log(
      chalk.yellow('  Warning: definition unreadable; workspace references not checked.'),
    );
  }
}
