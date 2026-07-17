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
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (!signal) return; // never settles — harmless in a race with a timeout
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, cleanup };
}
