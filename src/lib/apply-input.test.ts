import { describe, expect, test } from 'bun:test';
import { CliError, EXIT } from './cli-errors.js';
import { parseJsonInput, toValidationError } from './apply-input.js';

describe('parseJsonInput', () => {
  test('parses valid JSON', () => {
    expect(parseJsonInput('{"a":1}')).toEqual({ a: 1 });
  });

  test('throws CliError(VALIDATION, invalid_json) on malformed JSON', () => {
    try {
      parseJsonInput('{not json');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      if (err instanceof CliError) {
        expect(err.exitCode).toBe(EXIT.VALIDATION);
        expect(err.detail.code).toBe('invalid_json');
      }
    }
  });

  test('embeds a non-empty parser detail in the user-facing message', () => {
    // The parser wording belongs to the JS engine (and differs between the
    // Bun test runtime and the Node the published CLI runs under), so pin the
    // wrap and that a detail is present rather than the engine's text. No
    // known input makes the engine emit a multi-line message, so the
    // whitespace-collapse in parseJsonInput is deliberately left unasserted.
    try {
      parseJsonInput('{not json');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      if (err instanceof CliError) {
        expect(err.message).toStartWith('Input on stdin is not valid JSON: ');
        expect(err.message).toEndWith('.');
        expect(err.message.length).toBeGreaterThan('Input on stdin is not valid JSON: .'.length);
      }
    }
  });
});

describe('toValidationError', () => {
  test('wraps a validator throw with remediation pointing at the example command', () => {
    const err = toValidationError(new Error('Invalid container profile configuration:\n  base_image: bad'),
      'pi-tin container-profile show <name> --json');
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.detail.code).toBe('validation');
    expect(err.message).toContain('base_image');
    expect(err.detail.remediation).toContain('container-profile show');
  });
});
