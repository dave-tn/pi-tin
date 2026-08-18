import { ensureInitialised } from '../lib/init-guard.js';
import {
  agentDefinitionExists,
  loadAgentDefinition,
  loadAgentDefinitions,
  writeAgentDefinition,
} from '../lib/agent-definitions.js';
import { findBuiltInByName, findBuiltInByPackage, packagesCollide } from '../lib/agents.js';
import {
  caseFoldingNameMessage,
  findCaseFoldingStemOnDisk,
  getAgentDefinitionsDir,
  isSafePathSegment,
  SAFE_PATH_SEGMENT_RULE,
} from '../lib/paths.js';
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

      // The loader also drops a definition whose package duplicates another
      // custom's, so writing one would report success for a file that never
      // takes effect anywhere. Entries under this name are the file being
      // written, not a rival — an in-place update keeps its own package.
      // Warnings this load prints concern pre-existing bad files, not this write.
      const otherDefinitions = loadAgentDefinitions().filter(
        (agent) => agent.name.toLowerCase() !== name.toLowerCase(),
      );
      const samePackage = otherDefinitions.find((agent) =>
        packagesCollide(agent.package, definition.package),
      );
      if (samePackage !== undefined) {
        throw new CliError(
          `Package '${definition.package}' is already defined by the agent definition '${samePackage.name}'.`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: definition.package },
        );
      }

      // Before the exists/diff computation: `agentDefinitionExists` folds case,
      // so a variant of an existing name would otherwise diff as an update of
      // the definition it is about to destroy (and --dry-run would print it).
      const foldingStem = findCaseFoldingStemOnDisk(name, getAgentDefinitionsDir());
      if (foldingStem !== undefined) {
        throw new CliError(
          caseFoldingNameMessage('Agent definition', name, foldingStem),
          EXIT.VALIDATION,
          { code: 'validation', badInput: name },
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

function parseDefinition(raw: unknown): AgentDefinitionFile {
  try {
    return validateAgentDefinition(raw);
  } catch (err) {
    throw toValidationError(err, 'pi-tin agent show "Claude Code" --json');
  }
}
