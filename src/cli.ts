#!/usr/bin/env node

import chalk from 'chalk';
import { buildProgram } from './cli-program.js';
import { ensurePrerequisites } from './lib/prereqs.js';
import { runAutoStopHelper, AUTO_STOP_COMMAND } from './lib/auto-stop.js';
import { runUpdateCheckHelper, scheduleUpdateNotice, CHECK_FOR_UPDATE_COMMAND } from './lib/update-check.js';
import { isValidWorkspaceName } from './lib/workspaces.js';
import { CliError, EXIT, errorEnvelope } from './lib/cli-errors.js';
import { shouldEmitJson, printJson } from './lib/cli-output.js';
import { classifyHelpRequest } from './lib/help-request.js';
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

// Skip prereq checks for help/version
const isHelpOrVersion = args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-V') || args[0] === 'help';

if (!isHelpOrVersion) {
  if (process.platform !== 'darwin') {
    console.error(chalk.red('pi-tin requires macOS (uses Apple\'s native container CLI).'));
    process.exit(1);
  }
  await ensurePrerequisites();

  scheduleUpdateNotice({
    currentVersion: PKG_VERSION,
    argv: args,
    env: process.env,
    isTty: Boolean(process.stdout.isTTY),
  });
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CliError) {
    if (shouldEmitJson(undefined)) {
      process.stderr.write(JSON.stringify(errorEnvelope(err)) + '\n');
    } else {
      console.error(chalk.red(err.message));
      if (err.detail.remediation) {
        console.error(chalk.yellow(err.detail.remediation));
      }
    }
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(message));
  process.exit(EXIT.GENERAL);
}
