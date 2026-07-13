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
