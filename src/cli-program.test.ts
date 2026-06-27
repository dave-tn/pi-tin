import { describe, expect, test } from 'bun:test';
import { buildProgram } from './cli-program.js';

const meta = { version: '0.0.0-test', homepage: 'https://example.test' };

describe('buildProgram', () => {
  test('registers the top-level workspace + agent commands', () => {
    const program = buildProgram(meta);
    const names = program.commands.map((c) => c.name());
    for (const expected of [
      'create',
      'open',
      'list',
      'apply',
      'show',
      'detect-host',
      'container-profile',
      'agent-profile',
      'agent-guide',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('container-profile group exposes apply/delete/list/show', () => {
    const program = buildProgram(meta);
    const group = program.commands.find((c) => c.name() === 'container-profile');
    const subs = (group?.commands ?? []).map((c) => c.name()).sort();
    expect(subs).toEqual(['apply', 'delete', 'list', 'show']);
  });
});
