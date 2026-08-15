import { ensureInitialised } from '../lib/init-guard.js';
import {
  agentDefinitionExists,
  loadAgentDefinition,
  writeAgentDefinition,
} from '../lib/agent-definitions.js';
import { findBuiltInByName, findBuiltInByPackage } from '../lib/agents.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import { validateAgentDefinition } from '../lib/validators.js';
import type { AgentDefinitionFile } from '../lib/validators.js';
import { readStdin } from '../lib/stdin.js';
import { loadApplyDiffBase, parseJsonInput, toValidationError } from '../lib/apply-input.js';
import { diffJson } from '../lib/json-diff.js';
import { printJson } from '../lib/cli-output.js';

export function registerAgentApplyCommand(group: import('commander').Command): void {
  group
    .command('apply <name>')
    .description('Create or update an agent definition from a JSON object on stdin')
    .option('--dry-run', 'Print the diff without writing')
    .option('--json', 'Output machine-readable JSON (always JSON; accepted for consistency)')
    .action(async (name: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid agent definition name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          {
            code: 'validation',
            badInput: name,
            remediation: SAFE_PATH_SEGMENT_RULE,
          },
        );
      }

      const raw = parseJsonInput(await readStdin());
      const definition = parseDefinition(raw);

      // Both identity axes are the loader's built-in collision rules (built-ins
      // always win), enforced up front so apply never writes a file that a
      // built-in would shadow. Name first: it is what the user typed and what
      // the file would be called.
      const builtInName = findBuiltInByName(name);
      if (builtInName !== undefined) {
        throw new CliError(
          `Built-in agent '${name}' cannot be overridden; use a different agent name.`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: name },
        );
      }

      const builtInPackage = findBuiltInByPackage(definition.package);
      if (builtInPackage !== undefined) {
        throw new CliError(
          `Package '${definition.package}' belongs to the built-in agent '${builtInPackage.name}'.`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: definition.package },
        );
      }

      const exists = agentDefinitionExists(name);
      const before = exists
        ? loadApplyDiffBase('agent definition', name, () => loadAgentDefinition(name))
        : {};
      const changes = diffJson(before, definition);

      if (opts.dryRun === true) {
        printJson({ action: exists ? 'update' : 'create', name, dryRun: true, changes });
        return;
      }

      writeAgentDefinition(name, definition);
      printJson({ action: exists ? 'updated' : 'created', name, changes });
    });
}

// There is no `agent show`, so the example command is the listing — it prints
// the same field shape for every agent, built-in and custom.
function parseDefinition(raw: unknown): AgentDefinitionFile {
  try {
    return validateAgentDefinition(raw);
  } catch (err) {
    throw toValidationError(err, 'pi-tin agent list --json');
  }
}
