import { confirm } from '@inquirer/prompts';
import { CliError, EXIT } from './cli-errors.js';

export type ConfirmationDecision =
  | { kind: 'proceed' }
  | { kind: 'prompt' }
  | { kind: 'refuse' };

// Pure decision: --force always proceeds; otherwise we can only prompt when a
// human is actually attached. A non-interactive caller (agent/CI: stdin or
// stdout is not a TTY) must not be left hanging on a prompt it can never answer.
export function planConfirmation(input: { force: boolean; isInteractive: boolean }): ConfirmationDecision {
  if (input.force) return { kind: 'proceed' };
  if (!input.isInteractive) return { kind: 'refuse' };
  return { kind: 'prompt' };
}

export function isInteractiveSession(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// A neutral yes/no prompt for non-destructive recovery choices (e.g. offering a
// fallback after a failed rebuild). Callers must confirm a human is attached
// (isInteractiveSession) first — a non-interactive path must decide without
// prompting, never hang here.
export async function promptConfirm(message: string, promptDefault = false): Promise<boolean> {
  return confirm({ message, default: promptDefault });
}

// Effectful gate for destructive commands. Returns whether to proceed.
// Throws exit-4 (the reserved CONFIRMATION_REQUIRED) instead of prompting when
// non-interactive, so agents get a parseable envelope rather than a hung CLI.
export async function confirmDestructive(input: {
  message: string;
  action: string;
  force: boolean;
  promptDefault?: boolean;
  isInteractive?: boolean;
}): Promise<boolean> {
  const interactive = input.isInteractive ?? isInteractiveSession();
  const decision = planConfirmation({ force: input.force, isInteractive: interactive });

  switch (decision.kind) {
    case 'proceed':
      return true;
    case 'refuse':
      throw new CliError(
        `Cannot ${input.action} non-interactively without confirmation.`,
        EXIT.CONFIRMATION_REQUIRED,
        {
          code: 'confirmation_required',
          remediation: `Re-run with --force to ${input.action} non-interactively (confirm with the user first).`,
        },
      );
    case 'prompt':
      return confirm({ message: input.message, default: input.promptDefault ?? false });
  }
}
