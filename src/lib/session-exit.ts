import os from 'node:os';

/**
 * Signals whose default disposition kills pi-tin outright. `pi-tin open`
 * registers its session well before the attach and only arms auto-stop on the
 * way out, so dying on one of these mid-open strands a running container with
 * nothing to reclaim it until some later pi-tin invocation reaps the dead-PID
 * session.
 *
 * SIGINT is deliberately absent. It already means "abort the step in progress"
 * here — the agent install answers ^C by skipping the install and continuing
 * to the shell (see `onInterrupt` in `container.ts`) — and claiming it would
 * turn that into a full session teardown.
 */
export const SESSION_TERMINATION_SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGQUIT'] as const;

export type SessionTerminationSignal = (typeof SESSION_TERMINATION_SIGNALS)[number];

/** The shell's "killed by signal n" convention, as setProcessExitCode uses. */
export function signalExitCode(signal: SessionTerminationSignal): number {
  return 128 + os.constants.signals[signal];
}

// Seams for the process-global effects, so the handler is testable without
// raising real signals at the test runner (the AgentInstallDeps pattern).
export interface SessionExitDeps {
  addListener: (signal: SessionTerminationSignal, listener: () => void) => void;
  removeListener: (signal: SessionTerminationSignal, listener: () => void) => void;
  exit: (code: number) => void;
}

const defaultDeps: SessionExitDeps = {
  addListener: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener);
  },
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Arm an open workspace session's close-out against terminating signals, and
 * return that close-out. It runs at most once: whichever of the normal exit
 * path and a signal gets there first wins and the other awaits the same
 * result, so the close-out can never run twice against one session. Once it
 * has run the listeners are dropped and signals terminate pi-tin as usual.
 *
 * Cannot be armed any earlier than the workspace lock `pi-tin open` holds
 * while it starts the container and registers the session: the close-out takes
 * that same lock, and would wait forever on a lock its own process holds.
 */
export function guardSessionExit(
  closeSession: () => Promise<string>,
  overrides: Partial<SessionExitDeps> = {},
): () => Promise<string> {
  const deps: SessionExitDeps = { ...defaultDeps, ...overrides };
  const listeners = new Map<SessionTerminationSignal, () => void>();
  let closing: Promise<string> | null = null;

  const release = (): void => {
    for (const [signal, listener] of listeners) deps.removeListener(signal, listener);
    listeners.clear();
  };

  const close = (): Promise<string> => {
    closing ??= closeSession().finally(release);
    return closing;
  };

  for (const signal of SESSION_TERMINATION_SIGNALS) {
    const listener = (): void => {
      // Dropping every listener first restores the default disposition, so a
      // second signal still quits pi-tin: a close-out that is not finishing
      // (a contended workspace lock) must not leave an unkillable process.
      // Nothing is logged from here — the signal that reaches this handler has
      // usually taken the terminal with it.
      release();
      void close()
        .catch(() => undefined)
        .then(() => {
          deps.exit(signalExitCode(signal));
        });
    };
    listeners.set(signal, listener);
    deps.addListener(signal, listener);
  }

  return close;
}
