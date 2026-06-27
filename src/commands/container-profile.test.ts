import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerContainerProfileCommands } from './container-profile.js';

describe('registerContainerProfileCommands', () => {
  test('registers a container-profile group with apply, delete, list and show', () => {
    const program = new Command();
    registerContainerProfileCommands(program);

    const group = program.commands.find((c) => c.name() === 'container-profile');
    expect(group).toBeDefined();

    const subNames = (group?.commands ?? []).map((c) => c.name()).sort();
    expect(subNames).toEqual(['apply', 'delete', 'list', 'show']);
  });

  test('does not register a bare "profile" group', () => {
    const program = new Command();
    registerContainerProfileCommands(program);
    expect(program.commands.find((c) => c.name() === 'profile')).toBeUndefined();
  });
});
