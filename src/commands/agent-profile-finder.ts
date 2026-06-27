import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { getAgentProfilesDir, isSafePathSegment } from '../lib/paths.js';
import { loadAgentProfile } from '../lib/agent-profiles.js';

export function registerAgentProfileFinderCommand(
  agentProfileCmd: import('commander').Command,
): void {
  agentProfileCmd
    .command('finder [name]')
    .description('Open agent profiles directory in Finder')
    .action((name?: string) => {
      ensureInitialised();

      let targetPath: string;

      if (name) {
        try {
          const profile = loadAgentProfile(name);
          targetPath = profile.path;
        } catch (error) {
          // An unsafe name throws an instructive invalid-name error that must
          // surface as-is; only safe names get the "not found" rewrite.
          if (!isSafePathSegment(name)) {
            throw error;
          }
          console.error(chalk.red(`Agent profile '${name}' not found.`));
          process.exit(1);
        }
      } else {
        targetPath = getAgentProfilesDir();
      }

      console.log(chalk.dim(`Opening ${targetPath}`));
      execFileSync('open', [targetPath]);
    });
}
