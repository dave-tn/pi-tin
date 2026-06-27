export const EXIT = {
  SUCCESS: 0,
  GENERAL: 1,
  VALIDATION: 2,
  NOT_FOUND: 3,
  CONFIRMATION_REQUIRED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorDetail {
  // Machine-stable code, e.g. 'not_found' | 'validation'.
  code: string;
  remediation?: string;
  validValues?: string[];
  badInput?: string;
}

// A failure that carries a semantic exit code and structured detail, so the
// top-level handler can both exit with a meaningful code and (in JSON mode)
// emit an envelope the agent can parse instead of grepping prose.
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly detail: CliErrorDetail;

  constructor(message: string, exitCode: ExitCode, detail: CliErrorDetail) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export function errorEnvelope(
  err: CliError,
): { error: { message: string } & CliErrorDetail } {
  return { error: { message: err.message, ...err.detail } };
}
