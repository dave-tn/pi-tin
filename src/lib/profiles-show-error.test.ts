import { describe, expect, test } from 'bun:test';
import { EXIT } from './cli-errors.js';
import { notFoundContainerProfileError } from './profiles-show-error.js';

describe('notFoundContainerProfileError', () => {
  test('exit code is NOT_FOUND and message enumerates available profiles', () => {
    const err = notFoundContainerProfileError('node-slim', ['node-dev', 'bun-dev']);
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.detail.badInput).toBe('node-slim');
    expect(err.detail.validValues).toEqual(['node-dev', 'bun-dev']);
    expect(err.message).toContain('node-slim');
    expect(err.message).toContain('node-dev, bun-dev');
  });

  test('handles the no-profiles-configured case', () => {
    const err = notFoundContainerProfileError('x', []);
    expect(err.message).toContain('no container profiles are configured');
  });
});
