export type HelpRequest = 'json' | 'guide' | 'normal' | 'none';

// True when the invocation only asks for help or the version, so the CLI can
// skip the macOS/prereq gate. Flags must match what commander registers in
// cli-program.ts: `-v, --version` and `-h, --help`.
export function isHelpOrVersionRequest(args: string[]): boolean {
  const flags = ['--help', '-h', '--version', '-v'];
  return flags.some((flag) => args.includes(flag)) || args[0] === 'help';
}

// Invocations that only print embedded text need no container stack; keeping
// `agent-guide` exempt means the guide stays readable in environments where
// the prereq probe would fail (e.g. sandboxed shells).
export function isPrereqExemptRequest(args: string[]): boolean {
  return isHelpOrVersionRequest(args) || args[0] === 'agent-guide';
}

// Route a top-level help invocation. Subcommand help (`<cmd> --help` or
// `help <cmd>`) and non-help calls return 'normal'/'none' so commander
// handles them unchanged.
export function classifyHelpRequest(args: string[], isTty: boolean): HelpRequest {
  const wantsHelp = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  if (!wantsHelp) {
    return 'none';
  }

  const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
  const isTopLevel = nonFlagArgs.length === 0 || (nonFlagArgs[0] === 'help' && nonFlagArgs.length === 1);
  if (!isTopLevel) {
    return 'normal';
  }

  if (args.includes('--json')) {
    return 'json';
  }
  return isTty ? 'normal' : 'guide';
}

export type InvocationPlan =
  | { kind: 'proceed' }
  | { kind: 'unknown-command'; badInput: string }
  | { kind: 'missing-subcommand'; group: string; subcommands: string[] };

// Commander's root default action reports an unknown first positional as
// "too many arguments" (exit 1, no envelope), and `<unknown> --help` falls
// back to root help with exit 0 — a false positive for agents probing
// whether a command exists. Commander also has no real error for a bare
// group command (`agent-profile` with no subcommand) or `help <unknown>`:
// both throw commander.help whose message is the literal '(outputHelp)'
// placeholder, with the help text on the suppressed writeErr channel.
// Decide all of these here, before parse and before any --help routing.
// All root options are boolean, so the first non-flag token is always the
// intended command.
export function classifyInvocation(
  args: string[],
  knownCommands: string[],
  groupSubcommands: ReadonlyMap<string, string[]>,
): InvocationPlan {
  const [commandName, target] = args.filter((a) => !a.startsWith('-'));
  if (commandName === undefined) {
    return { kind: 'proceed' };
  }
  if (!knownCommands.includes(commandName)) {
    return { kind: 'unknown-command', badInput: commandName };
  }
  if (commandName === 'help' && target !== undefined && !knownCommands.includes(target)) {
    return { kind: 'unknown-command', badInput: target };
  }
  const subcommands = groupSubcommands.get(commandName);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (subcommands !== undefined && target === undefined && !wantsHelp) {
    return { kind: 'missing-subcommand', group: commandName, subcommands };
  }
  return { kind: 'proceed' };
}
