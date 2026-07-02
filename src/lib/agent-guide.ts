import uiSkillRaw from '../../AGENT_NL_UI_SKILL.md' with { type: 'text' };

/** Drop a leading `---` YAML frontmatter block (skill-discovery metadata) so the
 *  embedded guide reads as plain prose. */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\n[\s\S]*?\n---\n+/);
  return match ? md.slice(match[0].length) : md;
}

/** The natural-language UI skill, embedded from the repo-root file at build time. */
export const UI_GUIDE = stripFrontmatter(uiSkillRaw).trim();

const UI_GUIDE_APPLIES_WHEN =
  "Applies only when you are operating pi-tin as a human's conversational front-end. " +
  'For unattended or scripted use, ignore it and drive pi-tin from the contract above.';

export interface HelpCommand {
  command: string;
  summary: string;
  stdin?: string;
  args?: string[];
  flags?: string[];
}

export interface HelpSchema {
  tool: string;
  contract: {
    input: string;
    output: string;
    errors: string;
    edit: string;
    destructive: string;
  };
  exitCodes: Record<string, string>;
  commands: HelpCommand[];
  uiGuide: { appliesWhen: string; guide: string };
}

export const AGENT_HELP_SCHEMA: HelpSchema = {
  tool: 'pi-tin',
  contract: {
    input: 'For `apply`, send the object as a single JSON document on stdin.',
    output:
      'Data goes to stdout as JSON when --json is set or stdout is not a TTY. Diagnostics go to stderr.',
    errors:
      'In JSON mode, errors are a { "error": { "message", "code", ... } } envelope on stderr.',
    edit: 'Read-modify-write: `show --json` → edit the object → `apply --dry-run` → `apply`. apply is full-replace.',
    destructive:
      'Destructive commands require --force and return exit 4 (confirmation required) when run non-interactively without it. Preview with --dry-run first, then confirm with the user before passing --force.',
  },
  exitCodes: {
    '0': 'success',
    '1': 'general error',
    '2': 'validation (bad input / schema failure)',
    '3': 'not found',
    '4': 'confirmation required',
  },
  commands: [
    { command: 'list', summary: 'List workspaces', flags: ['--json'] },
    { command: 'show', summary: 'Show a workspace definition', args: ['<name>'], flags: ['--json'] },
    {
      command: 'apply',
      summary: 'Create or update a workspace',
      args: ['<name>'],
      stdin: 'workspace JSON',
      flags: ['--dry-run'],
    },
    {
      command: 'detect-host',
      summary: 'Print host facts (git identity, tz, API keys, known agents) as JSON',
    },
    { command: 'container-profile list', summary: 'List container profiles', flags: ['--json'] },
    {
      command: 'container-profile show',
      summary: 'Show a container profile',
      args: ['<name>'],
      flags: ['--json'],
    },
    {
      command: 'container-profile apply',
      summary: 'Create or update a container profile',
      args: ['<name>'],
      stdin: 'container-profile JSON',
      flags: ['--dry-run'],
    },
    {
      command: 'container-profile delete',
      summary: 'Delete a container profile',
      args: ['<name>'],
      flags: ['--force', '--dry-run', '--json'],
    },
    { command: 'agent-profile list', summary: 'List agent profiles', flags: ['--json'] },
    {
      command: 'agent-profile show',
      summary: 'Show an agent profile',
      args: ['<name>'],
      flags: ['--json'],
    },
    {
      command: 'agent-profile add',
      summary: 'Create an agent profile',
      args: ['<name>'],
      flags: ['--agent <agent>', '--host'],
    },
    {
      command: 'agent-profile delete',
      summary: 'Delete an agent profile',
      args: ['<name>'],
      flags: ['--force', '--dry-run', '--json'],
    },
  ],
  uiGuide: { appliesWhen: UI_GUIDE_APPLIES_WHEN, guide: UI_GUIDE },
};

export const AGENT_GUIDE = `pi-tin — agent usage guide

pi-tin manages macOS Apple-container dev workspaces. Drive it with the commands
below instead of editing YAML config by hand.

CONTRACT
- ${AGENT_HELP_SCHEMA.contract.input}
- ${AGENT_HELP_SCHEMA.contract.output}
- ${AGENT_HELP_SCHEMA.contract.errors}
- ${AGENT_HELP_SCHEMA.contract.edit}
- ${AGENT_HELP_SCHEMA.contract.destructive}

TYPICAL FLOWS
- New/edit workspace:
    pi-tin detect-host                         # git identity, tz, api keys, agents
    pi-tin show <name> --json                  # current state (if it exists)
    pi-tin apply <name> --dry-run < ws.json    # preview the diff
    pi-tin apply <name> < ws.json              # write (full replace)
- Edit a container profile:
    pi-tin container-profile show <name> --json > p.json
    # edit p.json, then:
    pi-tin container-profile apply <name> --dry-run < p.json
    pi-tin container-profile apply <name> < p.json
- Agent profiles (creation is flag-driven, not apply):
    pi-tin agent-profile add <name> --agent "Claude Code"
    pi-tin agent-profile delete <name> --dry-run   # preview blast radius
    pi-tin agent-profile delete <name> --force     # after confirming with the user

EXIT CODES
- 0 success | 1 general | 2 validation | 3 not found | 4 confirmation required

Run \`pi-tin --help --json\` for a machine-readable command/flag schema.

NATURAL-LANGUAGE UI
${UI_GUIDE_APPLIES_WHEN}

${UI_GUIDE}`;
