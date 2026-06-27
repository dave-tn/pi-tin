export type HelpRequest = 'json' | 'guide' | 'normal' | 'none';

// Route a top-level help invocation. Subcommand help (a non-flag token before
// the help flag, other than the literal `help`) and non-help calls return
// 'normal'/'none' so commander handles them unchanged.
export function classifyHelpRequest(args: string[], isTty: boolean): HelpRequest {
  const wantsHelp = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  if (!wantsHelp) {
    return 'none';
  }

  const firstNonFlag = args.find((a) => !a.startsWith('-'));
  const isTopLevel = firstNonFlag === undefined || firstNonFlag === 'help';
  if (!isTopLevel) {
    return 'normal';
  }

  if (args.includes('--json')) {
    return 'json';
  }
  return isTty ? 'normal' : 'guide';
}
