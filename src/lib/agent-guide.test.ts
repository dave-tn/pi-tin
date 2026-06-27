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
