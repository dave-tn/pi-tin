import fs from 'node:fs';
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { getBuildHashPath } from '../lib/paths.js';
import { workspaceExists, deleteWorkspace, assertValidWorkspaceName } from '../lib/workspaces.js';
import {
  containerNameFor,
  imageTagFor,
  getContainerState,
  deleteImage,
  imageExists,
} from '../lib/container.js';
import { stopAndRemoveContainer } from '../lib/container-lifecycle.js';
import {
  withWorkspaceLock,
  readRuntimeDecisionState,
  clearWorkspaceRuntimeState,
} from '../lib/runtime-state.js';
import { withExitHandling } from '../lib/exit-handling.js';
import { planDeleteWorkspace } from '../lib/workspace-plans.js';

export function registerDeleteCommand(
  program: import('commander').Command,
): void {
  program
    .command('delete <workspace>')
    .description('Delete a workspace')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (name: string, opts: { force?: boolean }) => {
      ensureInitialised();

      // delete never goes through loadWorkspace, so validate the raw argv
      // name before it reaches workspaceExists and runtime-state paths.
      assertValidWorkspaceName(name);

      if (!workspaceExists(name)) {
        console.error(
          chalk.red(
            `Workspace '${name}' not found.\nRun 'pi-tin list' to see available workspaces.`,
          ),
        );
        process.exit(1);
      }

      await withExitHandling(async () => {
        await withWorkspaceLock(name, async () => {
          const containerName = containerNameFor(name);
          const containerState = getContainerState(containerName);
          const runtime = readRuntimeDecisionState(name, containerState);
          const plan = planDeleteWorkspace({
            workspaceName: name,
            containerState,
            runtimeState: runtime.runtimeState,
            activeSessions: runtime.activeSessions,
          });

          if (plan.action === 'refuse') {
            throw new Error(plan.message);
          }

          const message = plan.stopRunningContainer
            ? `Workspace '${name}' is running. Delete it anyway?`
            : `Delete workspace '${name}'?`;
          const proceed = await confirmDestructive({
            message,
            action: `delete workspace '${name}'`,
            force: opts.force === true,
          });
          if (!proceed) {
            console.log('Cancelled.');
            return;
          }

          await stopAndRemoveContainer(containerName);

          clearWorkspaceRuntimeState(name);

          const imageTag = imageTagFor(name);
          if (imageExists(imageTag)) {
            try {
              deleteImage(imageTag);
              console.log(chalk.yellow(`Removed image: ${imageTag}`));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(chalk.yellow(`Warning: failed to remove image '${imageTag}': ${msg}`));
            }
          }

          const hashPath = getBuildHashPath(name);
          if (fs.existsSync(hashPath)) {
            fs.unlinkSync(hashPath);
          }

          deleteWorkspace(name);
          console.log(chalk.green(`✔ Deleted workspace '${name}'`));
        });
      });
    });
}
