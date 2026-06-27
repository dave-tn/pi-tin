import { ensureInitialised } from '../lib/init-guard.js';
import { listAgentProfiles, loadAgentProfile } from '../lib/agent-profiles.js';
import { printJson } from '../lib/cli-output.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentProfileShowCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('show <name>')
    .description('Show an agent profile')
    .option('--json', 'Output machine-readable JSON')
    .action((name: string, _opts: { json?: boolean }) => {
      ensureInitialised();

      const available = listAgentProfiles().map((p) => p.name);
      if (!available.includes(name)) {
        throw new CliError(
          available.length > 0
            ? `Agent profile '${name}' not found. Available: ${available.join(', ')}`
            : `Agent profile '${name}' not found — none are configured.`,
          EXIT.NOT_FOUND,
          {
            code: 'not_found',
            badInput: name,
            validValues: available,
            remediation: 'Run `pi-tin agent-profile list` to see available profiles.',
          },
        );
      }

      const meta = loadAgentProfile(name);
      const view = { name, agent: meta.agent, mode: meta.mode, mounts: meta.mounts, path: meta.path };
      // An agent profile has no separate human rendering, so output is JSON
      // regardless of --json; the flag is kept for contract consistency.
      printJson(view);
    });
}
