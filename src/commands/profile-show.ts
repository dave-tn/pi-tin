import chalk from 'chalk';
import { ensureInitialised } from '../lib/init-guard.js';
import { listContainerProfiles, loadContainerProfile } from '../lib/profiles.js';
import { toolDisplayName } from '../lib/agents.js';
import { printJson, shouldEmitJson } from '../lib/cli-output.js';
import { notFoundContainerProfileError } from '../lib/profiles-show-error.js';

export function registerContainerProfileShowCommand(
  profileCmd: import('commander').Command,
): void {
  profileCmd
    .command('show <name>')
    .description('Show details of a container profile')
    .option('--json', 'Output machine-readable JSON')
    .action((name: string, opts: { json?: boolean }) => {
      ensureInitialised();

      if (!listContainerProfiles().includes(name)) {
        throw notFoundContainerProfileError(name, listContainerProfiles());
      }

      const profile = loadContainerProfile(name);

      if (shouldEmitJson(opts.json)) {
        printJson(profile);
        return;
      }

      console.log(`${chalk.bold('Container profile:')} ${name}`);
      if (profile.description) {
        console.log(`  ${chalk.dim(profile.description)}`);
      }
      console.log('');
      console.log(`  ${chalk.dim('Image:')}       ${profile.base_image}`);
      console.log(`  ${chalk.dim('User:')}        ${profile.user}`);

      if (profile.packages.length > 0) {
        console.log(`  ${chalk.dim('Packages:')}    ${profile.packages.join(', ')}`);
      }
      if (profile.extra_packages.length > 0) {
        console.log(`  ${chalk.dim('Extra pkgs:')}  ${profile.extra_packages.join(', ')}`);
      }

      if (profile.global_tools.length > 0) {
        const toolNames = profile.global_tools.map(toolDisplayName);
        console.log(`  ${chalk.dim('Tools:')}       ${toolNames.join(', ')}`);
      }

      const envEntries = Object.entries(profile.env);
      if (envEntries.length > 0) {
        console.log(`  ${chalk.dim('Env:')}`);
        for (const [key, val] of envEntries) {
          console.log(`    ${key}=${val}`);
        }
      }

      if (profile.post_install.length > 0) {
        console.log(`  ${chalk.dim('Post-install:')}`);
        for (const cmd of profile.post_install) {
          console.log(`    ${cmd}`);
        }
      }
    });
}
