/**
 * Generic promise-chain mutex for serializing async read-modify-write
 * sequences within a single JS context. Prevents lost-update races when
 * concurrent callers read the same state, mutate independently, and write
 * back — the last writer silently wins.
 *
 * Cannot prevent races across separate JS contexts (e.g. the Options page
 * vs. the service worker); that would require per-key storage partitioning.
 */
export function createMutex<T = void>(): (fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return (fn: () => Promise<T>): Promise<T> => {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    const run = prev.then(fn, fn);
    // Release on BOTH paths. `run.then(ok, err)` (unlike `run.finally`) never
    // produces a discarded side-promise that rejects when `fn` rejects, so a
    // failed critical section can't leak an unhandled rejection.
    void run.then(() => release(), () => release());
    return run;
  };
}
