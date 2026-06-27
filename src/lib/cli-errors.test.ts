import { describe, expect, test } from 'bun:test';
import { CliError, EXIT, errorEnvelope } from './cli-errors.js';

describe('cli-errors', () => {
  test('CliError carries exit code and detail', () => {
    const err = new CliError("Container profile 'x' not found", EXIT.NOT_FOUND, {
      code: 'not_found',
      validValues: ['node-dev', 'bun-dev'],
      badInput: 'x',
    });
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.detail.code).toBe('not_found');
    expect(err.message).toBe("Container profile 'x' not found");
  });

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
