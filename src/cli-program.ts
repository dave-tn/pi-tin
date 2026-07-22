import { Command, CommanderError } from 'commander';
import { registerCreateCommand } from './commands/create.js';
import { registerOpenCommand, parseAttachOption } from './commands/open.js';
import { registerListCommand } from './commands/list.js';
import { registerStopCommand } from './commands/stop.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerCleanupCommand } from './commands/cleanup.js';
import { registerAddCommand } from './commands/add.js';
import { registerWorkspaceApplyCommand } from './commands/workspace-apply.js';
import { registerWorkspaceShowCommand } from './commands/workspace-show.js';
import { registerDetectHostCommand } from './commands/detect-host.js';
import { registerContainerProfileCommands } from './commands/container-profile.js';
import { registerAgentProfileAddCommand } from './commands/agent-profile-add.js';
import { registerAgentProfileListCommand } from './commands/agent-profile-list.js';
import { registerAgentProfileShowCommand } from './commands/agent-profile-show.js';
import { registerAgentProfileDeleteCommand } from './commands/agent-profile-delete.js';
import { registerAgentProfileDiscoverCommand } from './commands/agent-profile-discover.js';
import { registerAgentProfileFinderCommand } from './commands/agent-profile-finder.js';
import { registerAgentGuideCommand } from './commands/agent-guide.js';
import { runDefaultAction } from './lib/default-action.js';
import { CliError, EXIT } from './lib/cli-errors.js';

export function buildProgram(meta: { version: string; homepage: string }): Command {
  const program = new Command();

  program
    .name('pi-tin')
    .description('macOS-native workspace manager built on Apple\'s container CLI')
    .version(meta.version, '-v, --version')
    // Throw CommanderError instead of process.exit so usage errors reach the
    // top-level envelope handler. Commander writes its own message to stderr
    // before throwing; suppress that channel — usageErrorFrom re-carries the
    // message through the CliError renderer.
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--build', 'Force rebuild the container image when auto-opening a matched workspace')
    // The root default action suppresses commander's implicit `help [command]`
    // subcommand, so enable it explicitly for `pi-tin help <cmd>`.
    .helpCommand(true)
    .addHelpText('after', `\nAgents: run \`pi-tin agent-guide\` for machine usage.\nDocs: ${meta.homepage}`);

  // Workspace commands
  registerCreateCommand(program);
  registerOpenCommand(program);
  registerListCommand(program);
  registerStopCommand(program);
  registerDeleteCommand(program);
  registerCleanupCommand(program);
  registerAddCommand(program);
  registerWorkspaceApplyCommand(program);
  registerWorkspaceShowCommand(program);
  registerDetectHostCommand(program);

  // Container profile subcommands
  registerContainerProfileCommands(program);

  // Agent profile subcommands
  const agentProfileCmd = program
    .command('agent-profile')
    .description('Manage agent profiles');

  registerAgentProfileAddCommand(agentProfileCmd);
  registerAgentProfileListCommand(agentProfileCmd);
  registerAgentProfileShowCommand(agentProfileCmd);
  registerAgentProfileDeleteCommand(agentProfileCmd);
  registerAgentProfileDiscoverCommand(agentProfileCmd);
  registerAgentProfileFinderCommand(agentProfileCmd);

  // Machine-oriented usage guide
  registerAgentGuideCommand(program);

  // Default action — bare `pi-tin` opens the cwd-matched workspace; an
  // optional attach token (`pi-tin herdr`, `pi-tin shell`) overrides the
  // workspace's configured attach for this open only. classifyInvocation
  // admits only these tokens, so any other first positional never gets here.
  program
    .argument('[attach]', 'Attach override for the matched workspace: shell or herdr')
    .action(async (attachArg: string | undefined, opts: { build?: boolean }) => {
      await runDefaultAction({ ...opts, attach: parseAttachOption(attachArg) });
    });

  return program;
}

// program.commands does not include the implicit `help` command commander
// registers via helpCommand(true), so add it by hand.
export function knownCommandNames(program: Command): string[] {
  return [...program.commands.map((c) => c.name()), 'help'];
}

// Groups: every command that has subcommands (currently the *-profile
// commands). Invoked bare, commander has no real error for them: it throws
// commander.help with the literal '(outputHelp)' placeholder as the message.
// classifyInvocation uses this map to refuse such invocations with a real
// validation error before parse. Note the filter does not check for a
// default action — if a future group command gains one, its bare invocation
// would still be refused as missing-subcommand; exclude it here.
export function groupSubcommandNames(program: Command): Map<string, string[]> {
  return new Map(
    program.commands
      .filter((c) => c.commands.length > 0)
      .map((c): [string, string[]] => [c.name(), c.commands.map((s) => s.name())]),
  );
}

// undefined = commander already completed a zero-exit flow (help/version
// printed via stdout); callers exit 0. Anything else is a usage mistake and
// becomes part of the validation contract (exit 2, envelope code 'usage').
export function usageErrorFrom(err: CommanderError): CliError | undefined {
  if (err.exitCode === 0) {
    return undefined;
  }
  // A failing commander.help means commander printed help in place of a real
  // error (bare group command, `help <unknown>`): its message is the literal
  // '(outputHelp)' placeholder and the help text went to the suppressed
  // writeErr channel. classifyInvocation refuses those invocations (and
  // classifyHelpRequest routes `help help` to root help) before parse; this
  // backstop keeps the placeholder unprintable for any degenerate flow the
  // classifiers cannot see.
  const message = err.code === 'commander.help'
    ? 'Invalid or incomplete command.'
    : err.message.replace(/^error: /, '');
  return new CliError(message, EXIT.VALIDATION, {
    code: 'usage',
    remediation: 'Run `pi-tin <command> --help` for usage, or `pi-tin agent-guide` for the machine contract.',
  });
}
