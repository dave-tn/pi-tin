// Output is machine-readable JSON when the caller asked for it explicitly, or
// when stdout is not a TTY (piped / captured by an agent or CI). This is the
// honest "is a machine consuming this?" proxy — see the agent-CLI spec.
export function resolveJsonMode(jsonFlag: boolean | undefined, isTty: boolean): boolean {
  return jsonFlag === true || !isTty;
}

export function shouldEmitJson(jsonFlag: boolean | undefined): boolean {
  return resolveJsonMode(jsonFlag, Boolean(process.stdout.isTTY));
}

// Results go to stdout (the data channel). Pretty-printed for human-readable
// diffs; agents parse it the same either way.
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
