/**
 * Sensitive data handling — `%variable%` placeholder substitution.
 *
 * Secrets are stored locally and substituted into actions at execution time.
 * The LLM only sees `%variable_name%` placeholders — the actual values never
 * cross the network to the LLM provider.
 *
 * Usage:
 * 1. User stores secrets: `setSecret("email", "user@example.com")`
 * 2. User prompt: `"Log in with my email %email% and password %password%"`
 * 3. The LLM sees the prompt verbatim (placeholders intact).
 * 4. When the LLM emits `input(text="%email%")`, the executor substitutes
 * the real value at the last moment via {@link substituteSecrets} — the
 * LLM never sees the real value.
 *
 * This is strictly safer than injecting the real value into the LLM context
 * (where a prompt-injection attack could exfiltrate it).
 */

import { isExtensionWithSession } from "./runtime";

/** One stored secret. */
export interface SecretEntry {
  /** Placeholder name (used in `%name%` patterns). */
  name: string;
  /** The secret value (never sent to the LLM). */
  value: string;
  /** Unix ms timestamp when the entry was created/updated. */
  createdAt: number;
}

/** localStorage / chrome.storage key under which secrets are persisted. */
const STORAGE_KEY = "open_cowork_secrets";

/**
 * Serialize secret read-modify-write mutations (set/delete) so rapid clicks
 * can't lose an update to a lost-update race (finding: non-atomic RMW).
 */
let mutationChain: Promise<unknown> = Promise.resolve();
function withSecretLock<T>(fn: () => Promise<T>): Promise<T> {
 // Run `fn` once the previous mutation settles (fulfilled or rejected), so a
 // failed mutation doesn't break the chain for later callers.
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Regex matching `%identifier%` placeholders.
 *
 * Tightened: the identifier must START with a letter (not underscore, which
 * collided with %-formatted system strings like %_foo_%). Original was
 * `/%[a-zA-Z_][a-zA-Z0-9_]*%/g`.
 */
const PLACEHOLDER_PATTERN = /%([a-zA-Z][a-zA-Z0-9_]*)%/g;

/**
 * Non-global variant used only for the cheap "does this text contain any
 * `%placeholder%`?" probe. A *separate, non-global* regex avoids the stateful
 * `lastIndex` footgun of calling `.test()` on a `g`-flagged regex (which would
 * alternate true/false across calls).
 */
const HAS_PLACEHOLDER = /%[a-zA-Z][a-zA-Z0-9_]*%/;

/**
 * Flag set by the content script when the trusted service worker has already
 * resolved `%placeholder%` substitution + secret redaction on its behalf.
 *
 * In a content-script context `chrome.storage.session.get` throws
 * "Access to storage is not allowed from this context" (session storage
 * defaults to TRUSTED_CONTEXTS and the extension deliberately NEVER calls
 * `chrome.storage.session.setAccessLevel` for content scripts — doing so would
 * arm the `evaluate()` secret-exfiltration path). So the content script must
 * not touch the secret store. The SW redacts the result after it returns, so
 * the content-side `substituteSecrets`/`redactSecrets` calls become no-ops
 * while this flag is set.
 *
 * The demo (non-extension, in-page) path never loads the content script, so
 * the flag stays `false` there and substitution/redaction run normally against
 * `localStorage` — preserving that guard. See finding F-1.
 */
let secretsResolvedExternally = false;
export function setSecretsResolvedExternally(value: boolean): void {
  secretsResolvedExternally = value;
}

/**
 * Minimum secret length eligible for redaction.
 *
 * Previously `4`, which silently SKIPPED short user-defined secrets
 * (2–3 char PINs/OTPs/short tokens) so they could be read back from a
 * `type="text"` field and sent to the LLM provider UNREDACTED.
 *
 * These are the user's *explicitly-registered* secrets — there is no "common
 * short string" false-positive risk like there is for arbitrary page text, so
 * masking short ones is strictly correct. Set to `0` so EVERY stored secret is
 * redacted regardless of length. (The `> 0` guard in {@link redactSecrets}
 * only drops degenerate empty values, which cannot leak anything.)
 */
const MIN_REDACTABLE_LENGTH = 0;

/** Compiled artifacts used by {@link redactSecrets}. */
interface RedactionArtifacts {
  /** Longest-first alternation matching every eligible secret value. */
  pattern: RegExp;
  /** value → placeholder-name lookup for building the `[REDACTED:name]` marker. */
  valueToName: Map<string, string>;
  /** name → value lookup for `%placeholder%` substitution (keyed on the same cache). */
  nameToValue: Map<string, string>;
}

/** Validate a stored secret entry has string `name` + `value`. */
const isValidSecretEntry = (e: unknown): e is SecretEntry =>
  e != null &&
  typeof e === "object" &&
  typeof (e as SecretEntry).name === "string" &&
  typeof (e as SecretEntry).value === "string";

/**
 * Memoized redaction artifacts . {@link redactSecrets} is called
 * per-field, per-step, per-event; rebuilding the alternation RegExp and lookup
 * map on every call is wasteful. Cache the compiled artifacts and only recompute
 * when the underlying secret set actually changes (keyed on the eligible
 * name/value pairs).
 */
let redactionCache: { key: string; artifacts: RedactionArtifacts | null } | null = null;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build (or reuse a cached copy of) the redaction RegExp + value→name map for
 * the given secret list. Returns `null` when nothing is eligible for redaction.
 */
function getRedactionArtifacts(secrets: SecretEntry[]): RedactionArtifacts | null {
 // Cheap cache key from the full secret set (name+value), computed BEFORE the
 // filter/sort so the memoization short-circuits before the expensive work on
 // every `redactSecrets` / `substituteSecrets` call. The key covers the whole
 // set (including empty-valued entries) so no stale hits occur.
  const key = JSON.stringify(secrets.map((s) => [s.name, s.value]));
  if (redactionCache && redactionCache.key === key) return redactionCache.artifacts;

  const eligible = secrets
 // `>= MIN_REDACTABLE_LENGTH` (now 0) keeps every real secret; the
 // extra `> 0` guard only drops empty values that would break the regex.
    .filter((s) => s.value.length >= MIN_REDACTABLE_LENGTH && s.value.length > 0)
 // Sort longest-first so a secret that's a prefix of another doesn't mask it.
    .sort((a, b) => b.value.length - a.value.length);

  let artifacts: RedactionArtifacts | null;
  if (eligible.length === 0) {
    artifacts = null;
  } else {
 // Build a single alternation regex, escaping each value for regex safety.
    const pattern = new RegExp(eligible.map((s) => escapeRegex(s.value)).join("|"), "g");
 // Build a value→name lookup so the replacer can pick the right marker.
 // (If two secrets share a value, the first in the sorted array wins.)
    const valueToName = new Map<string, string>();
    for (const s of eligible) {
      if (!valueToName.has(s.value)) valueToName.set(s.value, s.name);
    }
 // Build the name→value lookup for substitution from the full secret set (so
 // every placeholder resolves, including empty-valued entries), memoized on
 // the same cache so per-call allocation is avoided on cache hits.
    const nameToValue = new Map<string, string>();
    for (const s of secrets) {
      if (!nameToValue.has(s.name)) nameToValue.set(s.name, s.value);
    }
    artifacts = { pattern, valueToName, nameToValue };
  }
  redactionCache = { key, artifacts };
  return artifacts;
}

/** Persist the secret list to whatever storage backend is available. */
async function persist(secrets: SecretEntry[]): Promise<void> {
  if (isExtensionWithSession()) {
 // chrome.storage.session — secrets stay in memory, never written to disk.
 // This is the MV3-recommended approach for sensitive data.
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: secrets });
    } catch (e) {
      console.error("[secrets] chrome.storage.session.set failed:", e);
      throw e;
    }
  } else {
 // SECURITY CAVEAT: in the in-page demo we fall back to localStorage, which
 // IS persisted to disk and IS readable by any script on the page (XSS).
 // This is acceptable ONLY for the demo (which has no real secrets); the
 // extension build uses chrome.storage.session exclusively.
 // Guard: if chrome.storage.session is actually available we must never
 // silently downgrade to on-disk localStorage — that would mean
 // isExtensionWithSession() is broken. Throw loudly instead of leaking
 // real secrets to disk/XSS-readable storage.
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      throw new Error(
        "[secrets] Refusing to use localStorage: chrome.storage.session is available but isExtensionWithSession() returned false. Possible regression in runtime detection.",
      );
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets));
    } catch (e) {
 // QuotaExceededError — surface so caller can react (trim older entries).
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        console.error("[secrets] localStorage quota exceeded:", e);
      }
      throw e;
    }
  }
}

/**
 * List all stored secrets.
 * In the extension, uses chrome.storage.session (cleared on extension unload).
 * In the in-page demo (no chrome.storage), falls back to localStorage with the
 * security caveat noted in {@link persist}. Returns an empty array if storage
 * is empty or unreadable.
 */
/** In-memory cache of the last `listSecrets` result.
 * `getRedactionArtifacts` already memoizes the compiled regex, but computing
 * its cache key needs the FULL secret list, and `listSecrets` hits
 * `chrome.storage.session.get` on EVERY call. `redactSecrets`/`substituteSecrets`
 * are called dozens of times per navigator step, so without a read cache each
 * call round-trips to storage (MED finding: uncached storage read per redact).
 * Invalidated on every successful `setSecret`/`deleteSecret`. */
let secretsCache: SecretEntry[] | null = null;

/** Monotonic version of the stored secret set. Bumped on every successful
 * set/delete so redaction caches keyed on (HistoryItem, secretVersion) can be
 * invalidated when a NEW secret is registered mid-run (MED finding: the
 * extractedContent redaction WeakMap never invalidated on secret-set change). */
let secretSetVersion = 0;
export function getSecretSetVersion(): number {
  return secretSetVersion;
}

export async function listSecrets(): Promise<SecretEntry[]> {
  if (secretsCache) return secretsCache;
  if (isExtensionWithSession()) {
    try {
      const res = await chrome.storage.session.get(STORAGE_KEY);
      const v = res[STORAGE_KEY];
 // Defensive: a corrupted / legacy / non-array value for this key would
 // otherwise be returned as-is and every reader (.findIndex / .map /
 // .filter) would throw a TypeError. Mirror the localStorage branch's
 // safe-parse intent and only return a validated array of well-formed
 // entries (each must have string `name` + `value`).
      if (!Array.isArray(v)) return [];
      secretsCache = v.filter(isValidSecretEntry);
      return secretsCache;
    } catch (e) {
 // A real storage error must NOT be silently treated as "no secrets" —
 // callers rely on the distinction (e.g. redactSecrets must not return
 // unredacted text on a read failure). Surface it and let callers decide.
      console.error("[secrets] chrome.storage.session.get failed:", e);
      throw e;
    }
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
 // Defensive: mirror the extension branch. A corrupted / legacy / non-array
 // localStorage value would otherwise be returned as-is and every reader
 // (.findIndex / .map / .filter) would throw a TypeError. Only return a
 // validated array of well-formed entries (each must have string name+value).
    if (!Array.isArray(parsed)) return [];
    secretsCache = parsed.filter(isValidSecretEntry);
    return secretsCache;
  } catch {
    secretsCache = [];
    return secretsCache;
  }
}

/**
 * Create or update a secret. If a secret with the same name exists, it is
 * replaced; otherwise the new entry is appended.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  return withSecretLock(async () => {
    // `.slice()` so we never mutate the cached array in place (a throw during
    // `persist` would otherwise leave the cache reflecting an unpersisted set).
    const secrets = (await listSecrets()).slice();
    const idx = secrets.findIndex((s) => s.name === name);
    const entry: SecretEntry = { name, value, createdAt: Date.now() };
    if (idx >= 0) secrets[idx] = entry;
    else secrets.push(entry);
    await persist(secrets);
    // Invalidate the read cache + bump the version so redaction caches keyed on
    // the secret-set version are dropped (MED finding: cache never invalidated
    // on secret-set change). Bumped only after a successful persist.
    secretsCache = null;
    secretSetVersion++;
  });
}

/** Delete the secret with the given name (no-op if it doesn't exist). */
export async function deleteSecret(name: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = (await listSecrets()).filter((s) => s.name !== name);
    await persist(secrets);
    // Invalidate the read cache + bump the version (see setSecret).
    secretsCache = null;
    secretSetVersion++;
  });
}

/** Options controlling {@link substituteSecrets}. */
export interface SubstituteSecretsOptions {
  /**
 * Whether `text` is bound for a TRUSTED sink — a destination whose identity is
 * fixed by the user's own request, NOT one whose parameters can be steered by
 * page content or by an LLM / prompt-injection attacker.
 *
 * Real secret values are only injected into trusted sinks. For an untrusted
 * sink the `%name%` placeholders are left INTACT, so a prompt-injection attack
 * cannot redirect a real credential into an attacker-chosen field or target
 * .
 *
 * Defaults to `true` to preserve the behavior of the sole legitimate caller
 * (the `input` executor, which types into a user-requested field). Any caller
 * that substitutes into an attacker- or LLM-controlled action target MUST pass
 * `{ trusted: false }`.
 */
  trusted?: boolean;
}

/**
 * Substitute `%variable%` placeholders in a string with the actual secret
 * values. Called at action-execution time so the LLM never sees real values.
 *
 * Unknown placeholders (the store reads fine, but no secret with that name
 * exists) are left intact, so they remain visible in error messages.
 *
 * SECURITY : real secret values are only substituted into TRUSTED
 * sinks. When `options.trusted` is `false` the placeholders are returned
 * verbatim, so a prompt-injection-controlled action target can never receive a
 * real credential. See {@link SubstituteSecretsOptions.trusted}.
 *
 * A STORAGE READ FAILURE is a distinct case: we cannot tell whether a given
 * `%name%` is real, so leaving it intact would let the executor type the
 * literal text `%email%` into a form field or forward it to the LLM. That is a
 * silent functional bug, so we fail loudly (throw) and let the caller mark the
 * action failed. This mirrors the closed-failure contract of {@link
 * redactSecrets}.
 */
export async function substituteSecrets(
  text: string,
  options: SubstituteSecretsOptions = {},
): Promise<string> {
  const { trusted = true } = options;
 // Untrusted sink: never inject real secret values. Return placeholders intact
 // so nothing sensitive can be redirected into an injection-controlled target.
  if (!trusted) return text;
  // F-1 short-circuit: text with no `%placeholder%` has nothing to substitute,
  // so skip the store read entirely. This is critical in a content-script
  // context, where `chrome.storage.session.get` throws and would otherwise make
  // EVERY placeholder-free input action fail closed. The SW resolves
  // placeholders before dispatch, so a substituted input text also carries no
  // placeholder here and likewise short-circuits.
  if (!HAS_PLACEHOLDER.test(text)) return text;
  // If the trusted SW already resolved secrets on our behalf, never read the
  // (unreadable from a content script) session store — return unchanged.
  if (secretsResolvedExternally) return text;
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
 // Storage read failure → fail closed (throw) rather than silently leaving
 // `%name%` placeholders intact, which the executor would treat as literal
 // text. Unknown placeholders are handled separately (below) and are NOT an
 // error.
    console.error(
      "[secrets] substituteSecrets: could not load secrets; cannot safely substitute (failing action):",
      e,
    );
    throw e;
  }
 // Reuse the memoized name→value map (built alongside redaction artifacts and
 // keyed on the same secret-set signature) so we don't re-allocate it on every
 // per-field/per-step substitution call. Fall back to a fresh map only when no
 // artifacts were produced.
  const artifacts = getRedactionArtifacts(secrets);
  const map = artifacts ? artifacts.nameToValue : new Map(secrets.map((s) => [s.name, s.value]));
  return text.replace(PLACEHOLDER_PATTERN, (match, name: string) => map.get(name) ?? match);
}

/**
 * Extract the names of every `%placeholder%` in a string (deduped, order
 * preserved). Useful for surfacing "this prompt references %email% — set
 * it first" hints in the UI.
 */
export function extractPlaceholders(text: string): string[] {
  const matches = text.matchAll(PLACEHOLDER_PATTERN);
  const names = new Set<string>();
  for (const m of matches) names.add(m[1]);
  return Array.from(names);
}

/**
 * Redact known secret values from a string (for logging).
 * Replaces each occurrence of a stored secret value with a non-reversible
 * marker `[REDACTED:name]` so logs don't leak credentials AND so a reader can
 * tell which secret was redacted (useful for debugging) without being able to
 * recover the original value.
 *
 * Implementation note: uses a single-pass alternation regex (longest-first)
 * rather than the previous `split/join` per secret — which was O(n*m) and
 * could redact substrings of already-redacted markers.
 *
 * Secrets are matched longest-first to avoid partial-match leaks (e.g. if one
 * secret's value is a prefix of another).
 *
 * ALL stored secrets are redacted regardless of length. We no longer
 * skip short values — a 2–3 char user-secret that lands in a visible input
 * field must still be masked before it reaches the LLM provider. Only
 * degenerate empty values are excluded (they cannot leak anything and an empty
 * alternation would corrupt the regex).
 */
export async function redactSecrets(text: string): Promise<string> {
  // F-1: when the trusted SW has already resolved secrets on our behalf, the
  // content script must NOT read `chrome.storage.session` (it throws
  // "Access to storage is not allowed from this context" there). The SW redacts
  // the returned result, so skip the store read and return the text unchanged.
  // This keeps the content script from masking ALL extracted page text while
  // still preserving the demo (non-extension) guard, where the flag is false and
  // redaction runs normally against localStorage.
  if (secretsResolvedExternally) return text;
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
 // If we can't load the secret store, we MUST NOT return `text` unchanged —
 // that would leak unredacted secrets into logs. Mask the whole line instead.
    console.warn("[secrets] redactSecrets: could not load secrets; masking output to avoid leak:", e);
    return "[REDACTED: secret store unavailable]";
  }
 // Reuse the memoized alternation regex + value→name map ; only
 // recomputed when the underlying secret set changes.
  const artifacts = getRedactionArtifacts(secrets);
  if (!artifacts) return text;
  const { pattern, valueToName } = artifacts;
 // The cached regex carries the global flag; reset lastIndex defensively before
 // each reuse (String.prototype.replace resets it, but be explicit).
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => `[REDACTED:${valueToName.get(match) ?? "unknown"}]`);
}
