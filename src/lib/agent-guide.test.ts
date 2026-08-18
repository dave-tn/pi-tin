import { describe, expect, test } from 'bun:test';
import type { Command } from 'commander';
import { buildProgram } from '../cli-program.js';
import { AGENT_GUIDE, AGENT_HELP_SCHEMA } from './agent-guide.js';

describe('agent-guide content', () => {
  test('the guide names the core agent commands and JSON contract', () => {
    expect(AGENT_GUIDE).toContain('apply');
    expect(AGENT_GUIDE).toContain('--dry-run');
    expect(AGENT_GUIDE).toContain('detect-host');
    expect(AGENT_GUIDE).toContain('JSON');
  });

  test('the schema documents the exit codes', () => {
    expect(AGENT_HELP_SCHEMA.exitCodes['2']).toBeDefined();
    expect(AGENT_HELP_SCHEMA.exitCodes['3']).toBeDefined();
  });

  test('the schema documents the agent definition commands', () => {
    const summaries = new Map(AGENT_HELP_SCHEMA.commands.map((c) => [c.command, c.summary]));
    expect(summaries.get('agent list')).toBe('List agents (built-in and custom definitions)');
    expect(summaries.get('agent apply')).toBe(
      'Create or update a custom agent definition (built-in agents cannot be overridden)',
    );
    expect(summaries.get('agent delete')).toBe('Delete a custom agent definition');
    expect(summaries.get('agent show')).toBe(
      'Show an agent definition, built-in or custom, as agent-definition JSON. A built-in is a template: `agent apply` refuses built-in names and packages, so give it a new name and package.',
    );
  });

  test('the guide separates agent definitions from agent profiles and gives the order', () => {
    expect(AGENT_GUIDE).toContain('CONCEPTS');
    expect(AGENT_HELP_SCHEMA.concepts.agentDefinition).toContain('agent kind');
    expect(AGENT_HELP_SCHEMA.concepts.agentProfile).toContain('login');
    expect(AGENT_HELP_SCHEMA.concepts.customAgentOrder).toContain('`agent apply`');
    // The text guide carries the same three lines, so the two surfaces cannot drift.
    expect(AGENT_GUIDE).toContain(AGENT_HELP_SCHEMA.concepts.agentDefinition);
    expect(AGENT_GUIDE).toContain(AGENT_HELP_SCHEMA.concepts.agentProfile);
    expect(AGENT_GUIDE).toContain(AGENT_HELP_SCHEMA.concepts.customAgentOrder);
  });

  test('the guide shows the custom agent definition flow', () => {
    expect(AGENT_GUIDE).toContain('pi-tin agent list --json');
    expect(AGENT_GUIDE).toContain('pi-tin agent show "Claude Code" --json');
    expect(AGENT_GUIDE).toContain('pi-tin agent apply <name> --dry-run < a.json');
    expect(AGENT_GUIDE).toContain('pi-tin agent apply <name> < a.json');
  });

  test('the natural-language UI skill is embedded and gated to interactive use', () => {
    expect(AGENT_GUIDE).toContain('NATURAL-LANGUAGE UI');
    expect(AGENT_GUIDE).toContain('natural-language UI');
    expect(AGENT_HELP_SCHEMA.uiGuide.guide).toContain('natural-language UI');
    expect(AGENT_HELP_SCHEMA.uiGuide.appliesWhen).toContain('conversational front-end');
    // frontmatter is stripped from the embedded copy
    expect(AGENT_HELP_SCHEMA.uiGuide.guide.startsWith('---')).toBe(false);
  });
});

function resolveCommand(root: Command, path: string): Command | undefined {
  return path.split(' ').reduce<Command | undefined>(
    (current, segment) => current?.commands.find((c) => c.name() === segment),
    root,
  );
}

describe('agent help schema drift', () => {
  const program = buildProgram({ version: '0.0.0-test', homepage: 'https://example.invalid' });

  test('every registered command is documented as drivable or interactive-only', () => {
    const documented = new Set([
      ...AGENT_HELP_SCHEMA.commands.map((c) => c.command),
      ...AGENT_HELP_SCHEMA.interactiveOnly.map((c) => c.command),
      'agent-guide',
      'help',
    ]);
    const registered = [
      ...program.commands.map((c) => c.name()),
      ...program.commands.flatMap((group) =>
        group.commands.map((sub) => `${group.name()} ${sub.name()}`),
      ),
    ];
    const undocumented = registered.filter(
      (name) =>
        !documented.has(name)
        && !AGENT_HELP_SCHEMA.commands.some((c) => c.command.startsWith(`${name} `))
        && !AGENT_HELP_SCHEMA.interactiveOnly.some((c) => c.command.startsWith(`${name} `)),
    );
    expect(undocumented).toEqual([]);
  });

  test('every schema command documents exactly its real non-hidden flags', () => {
    const problems: string[] = [];
    for (const entry of AGENT_HELP_SCHEMA.commands) {
      const command = resolveCommand(program, entry.command);
      if (command === undefined) {
        problems.push(`unknown command '${entry.command}'`);
        continue;
      }
      // The implicit `-h, --help` lives outside command.options, so only
      // hidden options need excluding. Schema flag strings may carry arg
      // hints (`--agent <agent>`); compare on the long-flag token.
      const realFlags = command.options
        .filter((o) => !o.hidden)
        .map((o) => o.long)
        .filter((long): long is string => long !== undefined);
      const documentedFlags = (entry.flags ?? []).map((flag) => flag.split(' ')[0] ?? flag);
      problems.push(
        ...documentedFlags
          .filter((flag) => !realFlags.includes(flag))
          .map((flag) => `'${entry.command}' documents phantom flag '${flag}'`),
        ...realFlags
          .filter((flag) => !documentedFlags.includes(flag))
          .map((flag) => `'${entry.command}' does not document real flag '${flag}'`),
      );
    }
    expect(problems).toEqual([]);
  });

  test('every interactive-only entry exists on the program', () => {
    const unknown = AGENT_HELP_SCHEMA.interactiveOnly
      .filter((entry) => resolveCommand(program, entry.command) === undefined)
      .map((entry) => entry.command);
    expect(unknown).toEqual([]);
  });
});
