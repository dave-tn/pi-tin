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
  destructive?: true;
}

export interface HelpSchema {
  tool: string;
  contract: {
    input: string;
    output: string;
    errors: string;
    edit: string;
    destructive: string;
    interactive: string;
    sandboxing: string;
  };
  exitCodes: Record<string, string>;
  commands: HelpCommand[];
  interactiveOnly: { command: string; use: string }[];
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
    interactive:
      'Interactive-only commands (listed under interactiveOnly) refuse without a TTY: exit 1, error code interactive_only. Use the listed alternative.',
    sandboxing:
      'pi-tin needs the Apple container system service. Some sandboxed shells block access to it, so a running service can be reported as not running (error code container_system_not_running). Before starting or restarting the service in response to that error, verify with `container system status` from an unsandboxed shell.',
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
    {
      command: 'stop',
      summary: 'Stop a running workspace',
      args: ['<workspace>'],
      flags: ['--force', '--dry-run', '--json'],
      destructive: true,
    },
    {
      command: 'delete',
      summary: 'Delete a workspace: container, image, and config',
      args: ['<workspace>'],
      flags: ['--force', '--dry-run', '--json'],
      destructive: true,
    },
    {
      command: 'cleanup',
      summary: 'Remove stopped containers, dangling images, and unused volumes; --all wipes all pi-tin data',
      flags: ['--all', '--force', '--dry-run', '--json'],
      destructive: true,
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
      destructive: true,
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
      flags: ['--agent <agent>', '--host', '--json'],
    },
    {
      command: 'agent-profile delete',
      summary: 'Delete an agent profile',
      args: ['<name>'],
      flags: ['--force', '--dry-run', '--json'],
      destructive: true,
    },
  ],
  interactiveOnly: [
    { command: 'create', use: 'Use `apply <name>` with workspace JSON on stdin.' },
    { command: 'add', use: 'Use `show <name> --json`, edit projects, then `apply <name>`. (`add <workspace>` with an explicit name works headless.)' },
    { command: 'open', use: 'Requires a terminal — attaches a tmux session. No headless equivalent.' },
    { command: 'agent-profile discover', use: 'Use `agent-profile add <name> --agent <agent>`.' },
    { command: 'agent-profile finder', use: 'Opens macOS Finder. Use `agent-profile show <name> --json`.' },
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
- ${AGENT_HELP_SCHEMA.contract.interactive}
- ${AGENT_HELP_SCHEMA.contract.sandboxing}

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
- Stop or delete a workspace (destructive — preview, confirm with the user, then --force):
    pi-tin delete <name> --dry-run
    pi-tin delete <name> --force

EXIT CODES
- 0 success | 1 general | 2 validation | 3 not found | 4 confirmation required

Run \`pi-tin --help --json\` for a machine-readable command/flag schema.

NATURAL-LANGUAGE UI
${UI_GUIDE_APPLIES_WHEN}

${UI_GUIDE}`;
