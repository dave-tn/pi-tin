import { describe, expect, test } from 'bun:test';
import type { Command } from 'commander';
import { buildProgram } from '../cli-program.js';
import { AGENT_GUIDE, AGENT_HELP_SCHEMA } from './agent-guide.js';

function collectCommandPaths(command: Command, prefix = ''): string[] {
  return command.commands.flatMap((sub) => {
    const path = prefix === '' ? sub.name() : `${prefix} ${sub.name()}`;
    return [path, ...collectCommandPaths(sub, path)];
  });
}

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

  test('every schema command exists in the real program tree (no drift)', () => {
    const program = buildProgram({ version: '0.0.0-test', homepage: 'https://example.test' });
    const paths = new Set(collectCommandPaths(program));
    for (const { command } of AGENT_HELP_SCHEMA.commands) {
      expect(paths).toContain(command);
    }
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

  test('every schema command exists with the flags it claims', () => {
    const missing: string[] = [];
    for (const entry of AGENT_HELP_SCHEMA.commands) {
      const command = resolveCommand(program, entry.command);
      if (command === undefined) {
        missing.push(`unknown command '${entry.command}'`);
        continue;
      }
      for (const flag of entry.flags ?? []) {
        const long = flag.split(' ')[0];
        if (!command.options.some((o) => o.long === long)) {
          missing.push(`'${entry.command}' is missing documented flag '${long}'`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every interactive-only entry exists on the program', () => {
    const unknown = AGENT_HELP_SCHEMA.interactiveOnly
      .filter((entry) => resolveCommand(program, entry.command) === undefined)
      .map((entry) => entry.command);
    expect(unknown).toEqual([]);
  });
});
