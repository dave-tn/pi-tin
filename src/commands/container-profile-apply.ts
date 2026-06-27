import { ensureInitialised } from '../lib/init-guard.js';
import { listContainerProfiles, loadContainerProfile, writeContainerProfile } from '../lib/profiles.js';
import { isSafePathSegment, SAFE_PATH_SEGMENT_RULE } from '../lib/paths.js';
import { CliError, EXIT } from '../lib/cli-errors.js';
import { validateContainerProfile } from '../lib/validators.js';
import type { ContainerProfile } from '../lib/validators.js';
import { readStdin } from '../lib/stdin.js';
import { parseJsonInput, toValidationError } from '../lib/apply-input.js';
import { diffJson } from '../lib/json-diff.js';
import { printJson } from '../lib/cli-output.js';

export function registerContainerProfileApplyCommand(
  group: import('commander').Command,
): void {
  group
    .command('apply <name>')
    .description('Create or update a container profile from a JSON object on stdin')
    .option('--dry-run', 'Print the diff without writing')
    .option('--json', 'Output machine-readable JSON (always JSON; accepted for consistency)')
    .action(async (name: string, opts: { dryRun?: boolean; json?: boolean }) => {
      ensureInitialised();

      if (!isSafePathSegment(name)) {
        throw new CliError(
          `Invalid container profile name '${name}'. ${SAFE_PATH_SEGMENT_RULE}`,
          EXIT.VALIDATION,
          {
            code: 'validation',
            badInput: name,
            remediation: SAFE_PATH_SEGMENT_RULE,
          },
        );
      }

      const raw = parseJsonInput(await readStdin());
      const profile = parseProfile(raw);

      const exists = listContainerProfiles().includes(name);
      const before = exists ? loadContainerProfile(name) : {};
      const changes = diffJson(before, profile);

      if (opts.dryRun === true) {
        printJson({ action: exists ? 'update' : 'create', name, dryRun: true, changes });
        return;
      }

      writeContainerProfile(name, profile);
      printJson({ action: exists ? 'updated' : 'created', name, changes });
    });
}

function parseProfile(raw: unknown): ContainerProfile {
  try {
    return validateContainerProfile(raw);
  } catch (err) {
    throw toValidationError(err, 'pi-tin container-profile show <name> --json');
  }
}
