/**
 * Signals whose default disposition kills pi-tin outright. `pi-tin open`
 * registers its session well before the attach and only arms auto-stop on the
 * way out, so dying on one of these mid-open strands a running container with
 * nothing to reclaim it until some later pi-tin invocation reaps the dead-PID
 * session.
 *
 * SIGINT is deliberately absent. It already means "abort the step in progress"
 * here — the agent install answers ^C by skipping the install and continuing
 * to the shell (see `onInterrupt` in `container.ts`) — so closing the session
 * on it would tear down a workspace the user is still about to use.
 */
export const SESSION_TERMINATION_SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGQUIT'] as const;

export type SessionTerminationSignal = (typeof SESSION_TERMINATION_SIGNALS)[number];

// Seams for the process-global effects, so the handler is testable without
// raising real signals at the test runner (the AgentInstallDeps pattern).
export interface SessionExitDeps {
  addListener: (signal: SessionTerminationSignal, listener: () => void) => void;
  removeListener: (signal: SessionTerminationSignal, listener: () => void) => void;
  raise: (signal: SessionTerminationSignal) => void;
}

const defaultDeps: SessionExitDeps = {
  addListener: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener);
  },
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
};

/**
 * Close an open workspace session out before a terminating signal kills
 * pi-tin, and return the function that disarms it again.
 *
 * `closeSession` is synchronous by necessity, not preference. Any spawn
 * wrapper in flight (`spawnProcessGroupWithDeadline`) answers the same signal
 * by settling its own listeners and re-raising it against pi-tin, which then
 * meets the default disposition and terminates — so an asynchronous close-out
 * would still be pending, having done nothing, when the process died. Running
 * to completion inside the handler is what makes it win that race, and it is
 * also what stops the open carrying on to attach to a terminal that is gone:
 * nothing resumes after the re-raise.
 *
 * Cannot be armed any earlier than the workspace lock `pi-tin open` holds
 * while it starts the container and registers the session — see
 * closeSessionOnSignal for why that rules the lock out of the close-out too.
 */
export function guardSessionExit(
  closeSession: () => void,
  overrides: Partial<SessionExitDeps> = {},
): () => void {
  const deps: SessionExitDeps = { ...defaultDeps, ...overrides };
  const listeners = new Map<SessionTerminationSignal, () => void>();

  const release = (): void => {
    for (const [signal, listener] of listeners) deps.removeListener(signal, listener);
    listeners.clear();
  };

  for (const signal of SESSION_TERMINATION_SIGNALS) {
    const listener = (): void => {
      // Releasing first restores the default disposition, so the re-raise
      // below terminates pi-tin exactly as an unhandled signal would, and a
      // second signal still quits during the close-out.
      release();
      try {
        closeSession();
      } catch {
        // Best effort only: a failed close-out must not stop the signal.
      }
      deps.raise(signal);
    };
    listeners.set(signal, listener);
    deps.addListener(signal, listener);
  }

  return release;
}
