import { CliError, EXIT } from './cli-errors.js';

export function notFoundWorkspaceError(name: string, available: string[]): CliError {
  const message =
    available.length > 0
      ? `Workspace '${name}' not found. Available: ${available.join(', ')}`
      : `Workspace '${name}' not found — no workspaces configured.`;
  return new CliError(message, EXIT.NOT_FOUND, {
    code: 'not_found',
    badInput: name,
    validValues: available,
    remediation: 'Run `pi-tin list` to see available workspaces.',
  });
}
