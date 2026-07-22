import { describe, expect, test } from 'bun:test';
import { classifyHelpRequest, classifyInvocation, isHelpOrVersionRequest, isPrereqExemptRequest } from './help-request.js';
import { ATTACH_MODES } from './validators.js';

describe('classifyHelpRequest', () => {
  test('no help token → none', () => {
    expect(classifyHelpRequest(['list'], true)).toBe('none');
    expect(classifyHelpRequest([], true)).toBe('none');
  });

  test('top-level --help on a TTY → normal (commander handles it)', () => {
    expect(classifyHelpRequest(['--help'], true)).toBe('normal');
    expect(classifyHelpRequest(['-h'], true)).toBe('normal');
    expect(classifyHelpRequest(['help'], true)).toBe('normal');
  });

  test('top-level --help with captured output → guide', () => {
    expect(classifyHelpRequest(['--help'], false)).toBe('guide');
    expect(classifyHelpRequest(['help'], false)).toBe('guide');
  });

  test('top-level --help --json → json (regardless of TTY)', () => {
    expect(classifyHelpRequest(['--help', '--json'], true)).toBe('json');
    expect(classifyHelpRequest(['--json', '--help'], false)).toBe('json');
  });

  test('subcommand help falls through to commander', () => {
    expect(classifyHelpRequest(['create', '--help'], false)).toBe('normal');
    expect(classifyHelpRequest(['container-profile', 'apply', '--help'], false)).toBe('normal');
  });

  test('help <cmd> falls through to commander (regardless of TTY)', () => {
    expect(classifyHelpRequest(['help', 'show'], true)).toBe('normal');
    expect(classifyHelpRequest(['help', 'show'], false)).toBe('normal');
  });

  test('bare help stays top-level', () => {
    expect(classifyHelpRequest(['help'], true)).toBe('normal');
    expect(classifyHelpRequest(['help'], false)).toBe('guide');
  });

  test('help help is a root help request (commander cannot dispatch it)', () => {
    expect(classifyHelpRequest(['help', 'help'], true)).toBe('root');
    expect(classifyHelpRequest(['help', 'help'], false)).toBe('guide');
    expect(classifyHelpRequest(['help', 'help', '--json'], true)).toBe('json');
    expect(classifyHelpRequest(['help', 'help', '--json'], false)).toBe('json');
  });

  test('mixed help argv with a real target falls through to commander', () => {
    expect(classifyHelpRequest(['help', 'help', 'list'], true)).toBe('normal');
    expect(classifyHelpRequest(['help', 'help', 'list'], false)).toBe('normal');
  });
});

describe('isHelpOrVersionRequest', () => {
  test('registered version flags are recognised', () => {
    expect(isHelpOrVersionRequest(['-v'])).toBe(true);
    expect(isHelpOrVersionRequest(['--version'])).toBe(true);
  });

  test('help flags and leading help are recognised', () => {
    expect(isHelpOrVersionRequest(['-h'])).toBe(true);
    expect(isHelpOrVersionRequest(['--help'])).toBe(true);
    expect(isHelpOrVersionRequest(['help'])).toBe(true);
    expect(isHelpOrVersionRequest(['create', '--help'])).toBe(true);
  });

  test('unregistered -V is not recognised', () => {
    expect(isHelpOrVersionRequest(['-V'])).toBe(false);
  });

  test('ordinary commands are not help/version', () => {
    expect(isHelpOrVersionRequest([])).toBe(false);
    expect(isHelpOrVersionRequest(['list'])).toBe(false);
    expect(isHelpOrVersionRequest(['open', 'my-workspace'])).toBe(false);
  });
});

describe('isPrereqExemptRequest', () => {
  test('help/version requests are exempt', () => {
    expect(isPrereqExemptRequest(['--help'])).toBe(true);
    expect(isPrereqExemptRequest(['-v'])).toBe(true);
  });

  test('agent-guide is exempt (must stay readable in sandboxed shells)', () => {
    expect(isPrereqExemptRequest(['agent-guide'])).toBe(true);
    expect(isPrereqExemptRequest(['agent-guide', '--json'])).toBe(true);
  });

  test('ordinary commands still hit the gate', () => {
    expect(isPrereqExemptRequest(['list'])).toBe(false);
    expect(isPrereqExemptRequest(['open', 'my-workspace'])).toBe(false);
  });
});

describe('classifyInvocation', () => {
  const known = ['list', 'show', 'stop', 'help', 'container-profile', 'agent-profile'];
  const groups = new Map([
    ['container-profile', ['list', 'show', 'apply', 'delete']],
    ['agent-profile', ['add', 'list', 'show', 'delete', 'discover', 'finder']],
  ]);

  test('bare invocation proceeds', () => {
    expect(classifyInvocation([], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('flag-only invocation proceeds', () => {
    expect(classifyInvocation(['--build'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('known command proceeds', () => {
    expect(classifyInvocation(['list', '--json'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('unknown command is refused', () => {
    expect(classifyInvocation(['bogus'], known, groups, ATTACH_MODES)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('unknown command is refused even with --help', () => {
    expect(classifyInvocation(['bogus', '--help'], known, groups, ATTACH_MODES)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('flags before the positional are skipped', () => {
    expect(classifyInvocation(['--build', 'bogus'], known, groups, ATTACH_MODES)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('a bare group command is refused with its subcommand names', () => {
    expect(classifyInvocation(['agent-profile'], known, groups, ATTACH_MODES)).toEqual({
      kind: 'missing-subcommand',
      groupName: 'agent-profile',
      subcommands: ['add', 'list', 'show', 'delete', 'discover', 'finder'],
    });
    expect(classifyInvocation(['container-profile'], known, groups, ATTACH_MODES)).toEqual({
      kind: 'missing-subcommand',
      groupName: 'container-profile',
      subcommands: ['list', 'show', 'apply', 'delete'],
    });
  });

  test('a bare group command with a non-help flag is still refused', () => {
    expect(classifyInvocation(['agent-profile', '--json'], known, groups, ATTACH_MODES)).toEqual({
      kind: 'missing-subcommand',
      groupName: 'agent-profile',
      subcommands: ['add', 'list', 'show', 'delete', 'discover', 'finder'],
    });
  });

  test('a group command with a help flag proceeds (commander prints group help, exit 0)', () => {
    expect(classifyInvocation(['agent-profile', '--help'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['agent-profile', '-h'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('a group command with a subcommand proceeds, even an unknown one (commander reports it)', () => {
    expect(classifyInvocation(['agent-profile', 'list'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['agent-profile', 'bogus-sub'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('help with a known target proceeds', () => {
    expect(classifyInvocation(['help', 'list'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['help', 'agent-profile'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['help'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['help', 'help'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('help with an unknown target is refused as an unknown command', () => {
    expect(classifyInvocation(['help', 'bogus'], known, groups, ATTACH_MODES)).toEqual({ kind: 'unknown-command', badInput: 'bogus' });
  });

  test('attach-mode tokens proceed to the root default action', () => {
    expect(classifyInvocation(['herdr'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
    expect(classifyInvocation(['shell', '--build'], known, groups, ATTACH_MODES)).toEqual({ kind: 'proceed' });
  });

  test('attach-mode tokens are not commands: help targeting them is refused', () => {
    expect(classifyInvocation(['help', 'herdr'], known, groups, ATTACH_MODES)).toEqual({ kind: 'unknown-command', badInput: 'herdr' });
  });
});
