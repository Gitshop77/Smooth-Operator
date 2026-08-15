/**
 * Memoized redaction + injection scan, keyed by (input string, secrets
 * version).
 *
 * On a static page the same strings are redacted and injection-scanned on
 * EVERY step (`buildNavigatorUserMessage` re-processes the cached
 * BrowserState verbatim), so those per-step scans are pure repeated work.
 * Memoizing them turns the cost into a Map lookup while still running on
 * every step — and the secrets-version half of the key means a secret
 * registered mid-run immediately invalidates the stored redactions (the
 * output depends on the secret set, so a stale entry could ship a
 * pre-secret string to the provider).
 *
 * Fail-closed: only SUCCESSFUL results are cached. A throwing redaction
 * re-runs on the next call and degrades to the `REDACTION_FAILED`
 * placeholder (the same marker the message builders emit today) — never a
 * stale success, never the raw secret-bearing text.
 */

import { getSecretSetVersion, redactSecrets } from "./secrets";
import { scanForInjection } from "./security";
import { redactKeyShapes } from "./key-shape-redact";

/** Marker substituted for text whose redaction threw (fail-closed). */
export const REDACTION_FAILED = "[REDACTED: redaction failed]";

interface MemoEntry<T> {
  /** Secrets-set version the entry was computed under. */
  version: number;
  value: T;
}

let redactionMemo = new Map<string, MemoEntry<string>>();
let injectionMemo = new Map<string, MemoEntry<{ safe: boolean; warnings: string[] }>>();

/** Cap on memoized entries per map (mirrors run-history-utils' redact cache). */
const MAX_MEMO_ENTRIES = 1000;

/**
 * Bound a memo at {@link MAX_MEMO_ENTRIES} entries. Map keys iterate in
 * insertion order, so evicting the first key drops the OLDEST entry — on a
 * dynamic page a long run's unique strings can't accumulate without bound.
 */
function evictOldestIfOverCap<T>(map: Map<string, T>): void {
  if (map.size > MAX_MEMO_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Apply BOTH redactors — the stored-secret redactor (`redactSecrets`, by
 * value) and the key-shape redactor (`redactKeyShapes`, by credential
 * format). Mirrors the composition in `loop/messages.ts`'s `redactBoth`.
 * Rejections from the stored-secret pass propagate to the caller so the
 * memo can treat a throw as "do not cache" (fail-closed below).
 */
async function redactBoth(s: string): Promise<string> {
  const str = typeof s === "string" ? s : "";
  const stored = await redactSecrets(str);
  return redactKeyShapes(stored);
}

/**
 * Redact `text`, memoized by (input string, secrets version). On a cache
 * miss the underlying redactors run and the successful result is stored;
 * on a throw the `REDACTION_FAILED` placeholder is returned WITHOUT being
 * cached (a transient redactor failure must not poison the memo).
 */
export function memoizedRedact(text: string): Promise<string> {
  const version = getSecretSetVersion();
  const cached = redactionMemo.get(text);
  if (cached !== undefined && cached.version === version) {
    return Promise.resolve(cached.value);
  }
  return redactBoth(text).then(
    (value) => {
      redactionMemo.set(text, { version, value });
      evictOldestIfOverCap(redactionMemo);
      return value;
    },
    () => REDACTION_FAILED,
  );
}

/**
 * Scan `text` for prompt-injection patterns, memoized by (input string,
 * secrets version) like {@link memoizedRedact} so the per-step flagging of
 * stable BrowserState text is a Map lookup.
 */
export function memoizedInjectionScan(text: string): { safe: boolean; warnings: string[] } {
  const version = getSecretSetVersion();
  const cached = injectionMemo.get(text);
  if (cached !== undefined && cached.version === version) {
    return cached.value;
  }
  const value = scanForInjection(text);
  injectionMemo.set(text, { version, value });
  evictOldestIfOverCap(injectionMemo);
  return value;
}

/**
 * Drop all memoized entries. Called at run start (per-run isolation in the
 * long-lived service worker) and whenever the secrets-set version changes.
 * Idempotent and cheap — clearing empty maps is a no-op.
 */
export function clearRedactionMemo(): void {
  redactionMemo = new Map();
  injectionMemo = new Map();
}

/**
 * Test-only accessor for the current memo sizes (repo `__test_*` pattern).
 * Reads the live bindings because `clearRedactionMemo` reassigns the maps.
 */
export function __test_memoSizesForTests(): {
  redaction: number;
  injection: number;
} {
  return { redaction: redactionMemo.size, injection: injectionMemo.size };
}