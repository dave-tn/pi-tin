import { Command } from 'commander';
import { registerCreateCommand } from './commands/create.js';
import { registerOpenCommand } from './commands/open.js';
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

export function buildProgram(meta: { version: string; homepage: string }): Command {
  const program = new Command();

  program
    .name('pi-tin')
    .description('macOS-native workspace manager built on Apple\'s container CLI')
    .version(meta.version, '-v, --version')
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

  // Default action — bare `pi-tin` with no subcommand
  program.action(async (opts: { build?: boolean }) => {
    await runDefaultAction(opts);
  });

  return program;
}
