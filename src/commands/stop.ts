import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import {
  containerNameFor,
  getContainerState,
} from '../lib/container.js';
import { stopAndRemoveContainer } from '../lib/container-lifecycle.js';
import { ensureInitialised } from '../lib/init-guard.js';
import {
  withWorkspaceLock,
  readRuntimeDecisionState,
  clearWorkspaceRuntimeState,
} from '../lib/runtime-state.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { planStopWorkspace } from '../lib/workspace-plans.js';
import { assertValidWorkspaceName } from '../lib/workspaces.js';

export function registerStopCommand(
  program: import('commander').Command,
): void {
  program
    .command('stop <workspace>')
    .description('Stop a running workspace')
    .option('-f, --force', 'Skip confirmation prompt and kill if needed')
    .action(async (name: string, opts: { force?: boolean }) => {
      ensureInitialised();

      // stop never goes through loadWorkspace, so validate the raw argv name
      // before deriving container names and runtime-state paths from it.
      assertValidWorkspaceName(name);

      await withExitHandling(async () => {
        const containerName = containerNameFor(name);

        await withWorkspaceLock(name, async () => {
          const state = getContainerState(containerName);
          const runtime = readRuntimeDecisionState(name, state);
          const plan = planStopWorkspace({
            workspaceName: name,
            containerState: state,
            runtimeState: runtime.runtimeState,
            activeSessions: runtime.activeSessions,
            force: opts.force === true,
          });

          if (plan.action === 'refuse') {
            throw new Error(plan.message);
          }

          if (plan.action === 'noop') {
            await stopAndRemoveContainer(containerName);
            clearWorkspaceRuntimeState(name);
            console.log(chalk.dim(`Workspace '${name}' is not running.`));
            return;
          }

          const warnAboutInconsistentRuntime = plan.action === 'stop'
            ? plan.warnAboutInconsistentRuntime
            : false;

          if (plan.action === 'confirm') {
            const proceed = await confirmDestructive({
              message: plan.message,
              action: `stop workspace '${name}'`,
              force: opts.force === true,
            });
            if (!proceed) {
              console.log('Cancelled.');
              return;
            }
          }

          if (warnAboutInconsistentRuntime) {
            console.warn(chalk.yellow(`Warning: runtime state is inconsistent for workspace '${name}'. Stopping it anyway.`));
          }

          await stopAndRemoveContainer(containerName, { force: opts.force === true });
          clearWorkspaceRuntimeState(name);
          console.log(chalk.green(`Stopped workspace '${name}'`));
        });
      });
    });
}
