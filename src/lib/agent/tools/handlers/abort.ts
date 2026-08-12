/**
 * Shared abort-plumbing for long-running SW-RPC handlers.
 *
 * Several handlers race a `chrome.runtime.sendMessage` call against a 30s
 * timeout. Without honoring the step's `AbortSignal`, a user STOP issued
 * mid-step is not observed until that full timeout (or the SW response)
 * elapses. `rejectOnAbort` returns a promise that rejects the instant the
 * signal aborts, so it can be added to the `Promise.race`; callers must invoke
 * the returned `cleanup` in a `finally` to remove the listener.
 */
export function rejectOnAbort(signal?: AbortSignal): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  // No signal → the promise never settles — harmless in a race with a timeout —
  // and there is no listener to clean up.
  if (!signal) {
    return { promise: new Promise<never>(() => {}), cleanup: () => {} };
  }
  const abortError = () => new DOMException("Aborted", "AbortError");
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, cleanup };
}

/** Fail before any privileged or DOM side effect when the run is cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}
