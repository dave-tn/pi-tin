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

  test('includes the parser detail on a single line', () => {
    const parserMessage = (() => {
      try {
        JSON.parse('{not json');
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    try {
      parseJsonInput('{not json');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      if (err instanceof CliError) {
        expect(err.message).toBe(
          `Input on stdin is not valid JSON: ${parserMessage.replace(/\s+/g, ' ')}.`,
        );
        expect(parserMessage.length).toBeGreaterThan(0);
        expect(err.message).not.toContain('\n');
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
