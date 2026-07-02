import { describe, expect, test } from 'bun:test';
import { classifyHelpRequest } from './help-request.js';

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
