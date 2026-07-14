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
      const documented = (entry.flags ?? []).map((flag) => flag.split(' ')[0] ?? flag);
      problems.push(
        ...documented
          .filter((flag) => !realFlags.includes(flag))
          .map((flag) => `'${entry.command}' documents phantom flag '${flag}'`),
        ...realFlags
          .filter((flag) => !documented.includes(flag))
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
