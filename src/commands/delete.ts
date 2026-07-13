import fs from 'node:fs';
import chalk from 'chalk';
import { confirmDestructive } from '../lib/confirmation.js';
import { ensureInitialised } from '../lib/init-guard.js';
import { getBuildHashPath } from '../lib/paths.js';
import { workspaceExists, deleteWorkspace, listWorkspaces, assertValidWorkspaceName } from '../lib/workspaces.js';
import { notFoundWorkspaceError } from '../lib/workspace-errors.js';
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
import { printJson, shouldEmitJson } from '../lib/cli-output.js';

export function registerDeleteCommand(
  program: import('commander').Command,
): void {
  program
    .command('delete <workspace>')
    .description('Delete a workspace')
    .option('-f, --force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview what would be deleted without deleting')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      // delete never goes through loadWorkspace, so validate the raw argv
      // name before it reaches workspaceExists and runtime-state paths.
      assertValidWorkspaceName(name);
      const json = shouldEmitJson(opts.json);

      if (!workspaceExists(name)) {
        throw notFoundWorkspaceError(name, listWorkspaces().map((w) => w.name));
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

          const imageTag = imageTagFor(name);

          if (opts.dryRun === true) {
            const impact = {
              action: 'delete',
              workspace: name,
              stopRunningContainer: plan.stopRunningContainer,
              image: imageExists(imageTag) ? imageTag : null,
            };
            if (json) {
              printJson({ ...impact, dryRun: true });
            } else {
              const runningNote = impact.stopRunningContainer ? ' (currently running — will be stopped)' : '';
              console.log(`Would delete workspace '${name}'${runningNote}.`);
              if (impact.image !== null) {
                console.log(`  Would remove image: ${impact.image}`);
              }
            }
            return;
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
            if (json) {
              printJson({ action: 'cancelled', workspace: name });
            } else {
              console.log('Cancelled.');
            }
            return;
          }

          await stopAndRemoveContainer(containerName);

          clearWorkspaceRuntimeState(name);

          let imageRemoved = false;
          if (imageExists(imageTag)) {
            try {
              deleteImage(imageTag);
              imageRemoved = true;
              if (!json) {
                console.log(chalk.yellow(`Removed image: ${imageTag}`));
              }
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
          if (json) {
            printJson({ action: 'deleted', workspace: name, imageRemoved });
          } else {
            console.log(chalk.green(`✔ Deleted workspace '${name}'`));
          }
        });
      });
    });
}
