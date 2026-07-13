#!/usr/bin/env node

import chalk from 'chalk';
import { CommanderError } from 'commander';
import { buildProgram, groupSubcommandNames, knownCommandNames, usageErrorFrom } from './cli-program.js';
import { ensurePrerequisites } from './lib/prereqs.js';
import { runAutoStopHelper, AUTO_STOP_COMMAND } from './lib/auto-stop.js';
import { runUpdateCheckHelper, scheduleUpdateNotice, CHECK_FOR_UPDATE_COMMAND } from './lib/update-check.js';
import { isValidWorkspaceName } from './lib/workspaces.js';
import { CliError, EXIT, errorEnvelope } from './lib/cli-errors.js';
import { shouldEmitJson, printJson } from './lib/cli-output.js';
import { classifyHelpRequest, classifyInvocation, isPrereqExemptRequest } from './lib/help-request.js';
import { AGENT_GUIDE, AGENT_HELP_SCHEMA } from './lib/agent-guide.js';

const args = process.argv.slice(2);

if (args[0] === AUTO_STOP_COMMAND) {
  const workspaceName = args[1];
  const deadlineMs = Number(args[2]);
  // The name reaches lock and runtime-state paths directly, so reject
  // malformed invocations of this hidden helper up front.
  if (typeof workspaceName !== 'string' || !isValidWorkspaceName(workspaceName) || !Number.isFinite(deadlineMs)) {
    process.exit(1);
  }
  await runAutoStopHelper(workspaceName, deadlineMs);
  process.exit(0);
}

if (args[0] === CHECK_FOR_UPDATE_COMMAND) {
  await runUpdateCheckHelper();
  process.exit(0);
}

const helpRequest = classifyHelpRequest(args, Boolean(process.stdout.isTTY));
if (helpRequest === 'json') {
  printJson(AGENT_HELP_SCHEMA);
  process.exit(0);
}
if (helpRequest === 'guide') {
  process.stdout.write(AGENT_GUIDE + '\n');
  process.exit(0);
}

const program = buildProgram({ version: PKG_VERSION, homepage: PKG_HOMEPAGE });

try {
  const knownCommands = knownCommandNames(program);
  const invocation = classifyInvocation(args, knownCommands, groupSubcommandNames(program));
  if (invocation.kind === 'unknown-command') {
    throw new CliError(`Unknown command '${invocation.badInput}'.`, EXIT.VALIDATION, {
      code: 'unknown_command',
      badInput: invocation.badInput,
      validValues: knownCommands,
      remediation: 'Run `pi-tin agent-guide` (or `pi-tin --help`) for the command list.',
    });
  }
  if (invocation.kind === 'missing-subcommand') {
    throw new CliError(`Missing subcommand for '${invocation.groupName}'.`, EXIT.VALIDATION, {
      code: 'usage',
      validValues: invocation.subcommands,
      remediation: `Run \`pi-tin ${invocation.groupName} --help\` for the subcommand list.`,
    });
  }

  // Skip prereq checks for help/version/agent-guide. The gate runs inside
  // this try so its CliErrors get the same envelope/exit-code rendering as
  // command failures.
  if (!isPrereqExemptRequest(args)) {
    if (process.platform !== 'darwin') {
      throw new CliError(
        'pi-tin requires macOS (uses Apple\'s native container CLI).',
        EXIT.GENERAL,
        { code: 'platform_unsupported' },
      );
    }
    await ensurePrerequisites();

    scheduleUpdateNotice({
      currentVersion: PKG_VERSION,
      argv: args,
      env: process.env,
      isTty: Boolean(process.stdout.isTTY),
    });
  }

  await program.parseAsync();
} catch (err) {
  const failure = err instanceof CommanderError ? usageErrorFrom(err) : err;
  if (failure === undefined) {
    process.exit(0);
  }
  if (failure instanceof CliError) {
    // Commander's parsed options aren't visible here, so detect --json from
    // raw argv (same approach as help-request.ts) — an explicit --json on a
    // TTY must still get the JSON error envelope.
    if (shouldEmitJson(args.includes('--json') ? true : undefined)) {
      process.stderr.write(JSON.stringify(errorEnvelope(failure)) + '\n');
    } else {
      console.error(chalk.red(failure.message));
      if (failure.detail.remediation) {
        console.error(chalk.yellow(failure.detail.remediation));
      }
    }
    process.exit(failure.exitCode);
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  console.error(chalk.red(message));
  process.exit(EXIT.GENERAL);
}
