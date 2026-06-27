import { CliError, EXIT } from './cli-errors.js';

// The agent surface contract is JSON. (JSON is valid YAML, but we parse and
// report errors as JSON for one unambiguous instruction.)
export function parseJsonInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('Input on stdin is not valid JSON.', EXIT.VALIDATION, {
      code: 'invalid_json',
      remediation: 'Send the object as a single JSON document on stdin.',
    });
  }
}

// Re-shape a validator throw (already a human-readable, field-enumerating
// message) into the structured CliError contract.
export function toValidationError(err: unknown, exampleCommand: string): CliError {
  const message = err instanceof Error ? err.message : String(err);
  return new CliError(message, EXIT.VALIDATION, {
    code: 'validation',
    remediation: `Run \`${exampleCommand}\` to see a valid example object.`,
  });
}
