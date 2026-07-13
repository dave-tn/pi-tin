import { describe, expect, test } from 'bun:test';
import { CommanderError } from 'commander';
import { buildProgram, usageErrorFrom } from './cli-program.js';
import { CliError, EXIT } from './lib/cli-errors.js';

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

describe('usageErrorFrom', () => {
  test('maps a usage error to a validation CliError, stripping the error: prefix', () => {
    const err = new CommanderError(1, 'commander.unknownOption', "error: unknown option '--bogus'");
    const cli = usageErrorFrom(err);
    expect(cli).toBeInstanceOf(CliError);
    if (!(cli instanceof CliError)) throw new Error('unreachable');
    expect(cli.exitCode).toBe(EXIT.VALIDATION);
    expect(cli.detail.code).toBe('usage');
    expect(cli.message).toBe("unknown option '--bogus'");
  });

  test('returns undefined for zero-exit flows (help, version)', () => {
    expect(usageErrorFrom(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'))).toBeUndefined();
    expect(usageErrorFrom(new CommanderError(0, 'commander.version', '0.0.0'))).toBeUndefined();
  });
});

describe('buildProgram exitOverride', () => {
  test('an unknown option throws CommanderError instead of exiting', async () => {
    const program = buildProgram(meta);
    const err = await program
      .parseAsync(['node', 'pi-tin', 'list', '--bogus'])
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    if (!(err instanceof CommanderError)) throw new Error('unreachable');
    expect(err.code).toBe('commander.unknownOption');
  });

  test('a missing required argument throws CommanderError', async () => {
    const program = buildProgram(meta);
    const err = await program
      .parseAsync(['node', 'pi-tin', 'show'])
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    if (!(err instanceof CommanderError)) throw new Error('unreachable');
    expect(err.code).toBe('commander.missingArgument');
  });
});
