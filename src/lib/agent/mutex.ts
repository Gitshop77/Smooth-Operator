/**
 * Generic promise-chain mutex for serializing async read-modify-write
 * sequences within a single JS context. Prevents lost-update races when
 * concurrent callers read the same state, mutate independently, and write
 * back — the last writer silently wins.
 *
 * Cannot prevent races across separate JS contexts (e.g. the Options page
 * vs. the service worker); that would require per-key storage partitioning.
 *
 * NOT REENTRANT: a critical section must not acquire the same mutex again
 * (directly or transitively). An awaited inner acquisition queues behind the
 * outer section's release promise while the outer section waits for the
 * inner, so the chain deadlocks. Re-entry is deliberately not detected by
 * throwing at call time: a legitimate concurrent caller invokes the mutex
 * while a section is running too (and must queue), and the queue gate means
 * an awaited re-entry never reaches a section body — the two are
 * indistinguishable without async-context tracking, which the MV3 service
 * worker cannot provide. No caller in this codebase re-enters; sections must
 * stay free of same-mutex acquisitions.
 */
export function createMutex<T = void>(): <U extends Promise<T>>(fn: () => U) => U {
  let chain: Promise<void> = Promise.resolve();
  return <U extends Promise<T>>(fn: () => U): U => {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    const run = prev.then(fn, fn) as U;
    // Release on BOTH paths. `run.then(ok, err)` (unlike `run.finally`) never
    // produces a discarded side-promise that rejects when `fn` rejects, so a
    // failed critical section can't leak an unhandled rejection.
    void run.then(() => release(), () => release());
    return run;
  };
}
