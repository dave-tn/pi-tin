import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { resolveEnv } from './env.js';

describe('resolveEnv', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env['TEST_SECRET'];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env['TEST_SECRET'];
    } else {
      process.env['TEST_SECRET'] = originalKey;
    }
  });

  test('passes literal values through unchanged', () => {
    const result = resolveEnv({ FOO: 'bar', NUM: '42' });
    expect(result).toEqual({ FOO: 'bar', NUM: '42' });
  });

  test('resolves ${VAR} from host environment', () => {
    process.env['TEST_SECRET'] = 'my-secret-value';
    const result = resolveEnv({ API_KEY: '${TEST_SECRET}' });
    expect(result).toEqual({ API_KEY: 'my-secret-value' });
  });

  test('omits entry when host var is unset', () => {
    delete process.env['TEST_SECRET'];
    const result = resolveEnv({ API_KEY: '${TEST_SECRET}', OTHER: 'literal' });
    expect(result).toEqual({ OTHER: 'literal' });
  });

  test('preserves empty-string env vars', () => {
    process.env['TEST_SECRET'] = '';
    const result = resolveEnv({ API_KEY: '${TEST_SECRET}' });
    expect(result).toEqual({ API_KEY: '' });
  });

  test('does not interpolate ${VAR} embedded in other text', () => {
    process.env['TEST_SECRET'] = 'value';
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = resolveEnv({ MSG: 'prefix-${TEST_SECRET}-suffix' });
      expect(result).toEqual({ MSG: 'prefix-${TEST_SECRET}-suffix' });
    } finally {
      warn.mockRestore();
    }
  });

  test('warns when a value contains a partial ${VAR} that is not interpolated', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveEnv({ MSG: 'prefix-${TEST_SECRET}-suffix' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('MSG');
    } finally {
      warn.mockRestore();
    }
  });

  test('does not warn for whole-value ${VAR} or plain literals', () => {
    process.env['TEST_SECRET'] = 'value';
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveEnv({ A: '${TEST_SECRET}', B: 'plain', C: 'cost is $5' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('returns empty object for empty input', () => {
    expect(resolveEnv({})).toEqual({});
  });
});
