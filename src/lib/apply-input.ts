import { CliError, EXIT } from './cli-errors.js';

// The agent surface contract is JSON. (JSON is valid YAML, but we parse and
// report errors as JSON for one unambiguous instruction.) The parser's own
// detail is appended — collapsed to one line — so the instruction stays
// single-line while still pointing at where the JSON broke.
export function parseJsonInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
    throw new CliError(`Input on stdin is not valid JSON: ${detail}.`, EXIT.VALIDATION, {
      code: 'invalid_json',
      remediation: 'Send the object as a single JSON document on stdin.',
    });
  }
}

// apply is a full replace, so a corrupt existing file must not block the
// write — that is exactly when a full replace is the repair. The diff base
// degrades to {} (everything reads as added, like a create) and the real
// parse error surfaces as a warning on stderr, keeping stdout pure JSON.
export function loadApplyDiffBase(
  kind: 'workspace' | 'container profile',
  name: string,
  loadExisting: () => unknown,
): unknown {
  try {
    return loadExisting();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: existing ${kind} '${name}' could not be parsed; apply replaces it: ${detail}`);
    return {};
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
