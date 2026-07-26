import { describe, expect, spyOn, test } from 'bun:test';
import { CliError, EXIT } from './cli-errors.js';
import { loadApplyDiffBase, parseJsonInput, toValidationError } from './apply-input.js';

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

describe('loadApplyDiffBase', () => {
  test('passes a loadable existing document straight through', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const existing = { profile: 'node-dev', projects: ['/a'] };
      expect(loadApplyDiffBase('workspace', 'work', () => existing)).toBe(existing);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // apply is a full replace, so a corrupt existing document must degrade the
  // diff base rather than abort the write — and the real parse error has to
  // reach stderr, since stdout stays pure JSON for the agent surface.
  test('degrades a corrupt existing document to {} and warns with the real parse error', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = loadApplyDiffBase('container profile', 'node-dev', () => {
        throw new Error('Failed to parse YAML at /x/node-dev.yaml:\n  bad indentation');
      });

      expect(base).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] ?? [];
      expect(message).toBe(
        "Warning: existing container profile 'node-dev' could not be parsed; apply replaces it: "
        + 'Failed to parse YAML at /x/node-dev.yaml:\n  bad indentation',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('warns with a stringified non-Error throw rather than swallowing it', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadApplyDiffBase('workspace', 'work', () => {
        throw 'disk on fire';
      })).toEqual({});
      const [message] = warn.mock.calls[0] ?? [];
      expect(message).toBe(
        "Warning: existing workspace 'work' could not be parsed; apply replaces it: disk on fire",
      );
    } finally {
      warn.mockRestore();
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
