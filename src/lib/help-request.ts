export type HelpRequest = 'json' | 'guide' | 'normal' | 'none';

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
