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

export interface SessionExitGuard {
  /**
   * The normal exit path has started closing the session: a signal must let it
   * finish rather than replace it. It does strictly more — it snapshots
   * workspace state first — and it is already under way, so terminating on the
   * signal would lose the snapshot. The cut-down close-out still runs, as
   * insurance against the normal one being killed part-way through.
   */
  handOver: () => void;
  /** Drop the guard; later signals terminate pi-tin as they normally would. */
  release: () => void;
}

/**
 * Close an open workspace session out before a terminating signal kills
 * pi-tin.
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
 * A signal that lands while pi-tin is blocked in a synchronous child — the
 * interactive attach is an unbounded `spawnSync` — is queued by the runtime
 * and delivered when that call returns, which is why handOver matters: the
 * normal close-out has begun by then and must not be cut short.
 */
export function guardSessionExit(
  closeSession: () => void,
  overrides: Partial<SessionExitDeps> = {},
): SessionExitGuard {
  const deps: SessionExitDeps = { ...defaultDeps, ...overrides };
  const listeners = new Map<SessionTerminationSignal, () => void>();
  let handedOver = false;

  const release = (): void => {
    for (const [signal, listener] of listeners) deps.removeListener(signal, listener);
    listeners.clear();
  };

  for (const signal of SESSION_TERMINATION_SIGNALS) {
    const listener = (): void => {
      // Releasing first restores the default disposition, so the re-raise
      // below terminates pi-tin exactly as an unhandled signal would — and so
      // a second signal quits outright either way, leaving an escape hatch
      // from a close-out that is not finishing.
      release();
      try {
        closeSession();
      } catch {
        // Best effort only: a failed close-out must not stop the signal.
      }
      if (handedOver) {
        // Do not re-raise: the normal close-out is still running and does
        // strictly more — it snapshots workspace state first — so let it
        // finish and overwrite what was just armed. The close-out above still
        // runs, because that normal one may itself be inside a spawn wrapper
        // that answers this same signal by re-raising it against the default
        // disposition now restored, and that death would land after the
        // session record is gone and before the countdown is armed.
        return;
      }
      deps.raise(signal);
    };
    listeners.set(signal, listener);
    deps.addListener(signal, listener);
  }

  return {
    handOver: () => { handedOver = true; },
    release,
  };
}
