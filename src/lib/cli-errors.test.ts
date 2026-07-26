import { describe, expect, test } from 'bun:test';
import { CliError, EXIT, errorEnvelope } from './cli-errors.js';

describe('cli-errors', () => {
  test('errorEnvelope folds message into the detail object', () => {
    const err = new CliError('bad', EXIT.VALIDATION, { code: 'validation', remediation: 'fix it' });
    expect(errorEnvelope(err)).toEqual({
      error: { message: 'bad', code: 'validation', remediation: 'fix it' },
    });
  });

  test('errorEnvelope omits absent optional fields', () => {
    const err = new CliError('nope', EXIT.NOT_FOUND, { code: 'not_found' });
    expect(errorEnvelope(err)).toEqual({ error: { message: 'nope', code: 'not_found' } });
  });
});
