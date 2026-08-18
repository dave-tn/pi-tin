import { ensureInitialised } from '../lib/init-guard.js';
import { agentDefinitionExists, allAgents, loadAgentDefinition } from '../lib/agent-definitions.js';
import { isSafePathSegment } from '../lib/paths.js';
import { printJson } from '../lib/cli-output.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentShowCommand(agentCmd: import('commander').Command): void {
  agentCmd
    .command('show <name>')
    .description('Show an agent definition, built-in or custom')
    .option('--json', 'Output machine-readable JSON (always JSON; accepted for consistency)')
    .action((name: string, _opts: { json?: boolean }) => {
      ensureInitialised();

      // Case-insensitive: agent names are case-exclusive by construction
      // (built-ins are distinct; the loader and `agent apply` refuse custom
      // case-variants), so folding cannot be ambiguous — and it matches how
      // findBuiltInByName resolves names.
      const agents = allAgents();
      const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (agent === undefined) {
        // A definition file the loader dropped still exists on disk. An
        // invalid one surfaces its real parse error here rather than being
        // rewritten into "not found"; a collision-skipped one loads cleanly
        // and falls through — its skip warning is already on stderr from the
        // table load above. Unsafe segments are filtered first: definitionPath
        // throws its own invalid-name Error, which must not replace the
        // not_found envelope for a garbage name.
        if (isSafePathSegment(name) && agentDefinitionExists(name)) {
          loadAgentDefinition(name);
        }
        throw new CliError(
          `Agent '${name}' not found. Available: ${agents.map((a) => a.name).join(', ')}`,
          EXIT.NOT_FOUND,
          {
            code: 'not_found',
            badInput: name,
            validValues: agents.map((a) => a.name),
            remediation: 'Run `pi-tin agent list` to see available agents.',
          },
        );
      }

      // Exactly the agent-definition file shape, so show→edit→apply
      // round-trips; `name` is the apply argument, not payload. A built-in
      // shown this way is a template — apply refuses built-in names and
      // packages, so it needs a new name and package before write-back.
      const { name: _agentName, ...definition } = agent;
      printJson(definition);
    });
}
