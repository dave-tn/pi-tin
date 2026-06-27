import { CliError, EXIT } from './cli-errors.js';

export function notFoundContainerProfileError(name: string, available: string[]): CliError {
  const message =
    available.length > 0
      ? `Container profile '${name}' not found. Available: ${available.join(', ')}`
      : `Container profile '${name}' not found — no container profiles are configured.`;
  return new CliError(message, EXIT.NOT_FOUND, {
    code: 'not_found',
    badInput: name,
    validValues: available,
    remediation: 'Run `pi-tin container-profile list` to see available profiles.',
  });
}
