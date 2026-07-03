import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { createAgentProfile, findCreatableAgent, unknownAgentMessage } from '../lib/agent-profiles.js';
import { KNOWN_AGENTS } from '../lib/agents.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { CliError, EXIT } from '../lib/cli-errors.js';

export function registerAgentProfileAddCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('add <name>')
    .description('Create a new agent profile')
    .requiredOption('--agent <agent>', `Agent name (${KNOWN_AGENTS.map((a) => a.name).join(', ')})`)
    .option('--host', 'Mount host config directly instead of creating an isolated copy')
    .option('--json', 'Output machine-readable JSON')
    .action((name: string, opts: { agent: string; host?: boolean; json?: boolean }) => {
      ensureInitialised();

      // Validate the inputs up front so genuinely-bad input gets the
      // machine-readable validation envelope (exit 2), consistent with the
      // sibling commands.
      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid agent profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          { code: 'validation', badInput: name, remediation: SAFE_PATH_SEGMENT_RULE },
        );
      }

      if (!findCreatableAgent(opts.agent)) {
        throw new CliError(
          unknownAgentMessage(opts.agent),
          EXIT.VALIDATION,
          { code: 'validation', badInput: opts.agent, validValues: KNOWN_AGENTS.map((a) => a.name) },
        );
      }

      const mode = opts.host ? 'host' : 'isolated';

      // Deliberately not wrapped: already-exists, host-mode-unsupported, and
      // I/O failures are not input validation — they surface their real
      // message via the general error path (exit 1).
      const profileDir = createAgentProfile(name, opts.agent, mode);

      if (shouldEmitJson(opts.json)) {
        printJson({ action: 'created', profile: name, agent: opts.agent, mode, path: profileDir });
        return;
      }

      console.log(chalk.green(`✔ Created agent profile '${name}' for ${opts.agent} (${mode})`));
      console.log('');
      console.log(`  Agent profile directory: ${chalk.dim(profileDir)}`);
      console.log('');

      if (mode === 'host') {
        console.log(`  This profile mounts your host config directly into containers.`);
        console.log(`  Changes inside the container will affect your host configuration.`);
      } else {
        console.log(
          `  You'll need to log in the first time you open a workspace using this profile.`,
        );
        console.log(`  After that, your session persists across workspace restarts.`);
        console.log('');
        console.log(
          `  To add custom config (skills, MCP servers, etc.), copy files into the profile directory.`,
        );
        console.log(`  Run ${chalk.cyan(`pi-tin agent-profile finder ${name}`)} to open it in Finder.`);
      }
    });
}
