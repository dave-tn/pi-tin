import { describe, expect, test } from 'bun:test';
import { classifyHelpRequest, isHelpOrVersionRequest, isPrereqExemptRequest } from './help-request.js';

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
