import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { listAgentProfiles } from '../lib/agent-profiles.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

export function registerAgentProfileListCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('list')
    .description('List all agent profiles')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      ensureInitialised();

      const profiles = listAgentProfiles();

      if (shouldEmitJson(opts.json)) {
        printJson(profiles);
        return;
      }

      if (profiles.length === 0) {
        console.log('No agent profiles configured.');
        console.log(`Run ${chalk.cyan('pi-tin agent-profile add <name> --agent <agent>')} to create one.`);
        return;
      }

      const nameWidth = Math.max('NAME'.length, ...profiles.map((p) => p.name.length));
      const agentWidth = Math.max('AGENT'.length, ...profiles.map((p) => p.agent.length));
      const modeWidth = Math.max('MODE'.length, ...profiles.map((p) => p.mode.length));

      const header = [
        'NAME'.padEnd(nameWidth),
        'AGENT'.padEnd(agentWidth),
        'MODE'.padEnd(modeWidth),
      ].join('  ');

      console.log(chalk.bold(header));

      for (const profile of profiles) {
        console.log(
          [
            profile.name.padEnd(nameWidth),
            profile.agent.padEnd(agentWidth),
            profile.mode.padEnd(modeWidth),
          ].join('  '),
        );
      }
    });
}
