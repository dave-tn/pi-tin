/** Narrow an unknown value to a non-null object (including arrays) whose properties can be inspected. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The message of a thrown value, whether or not it is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
