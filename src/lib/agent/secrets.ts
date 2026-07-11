/**
 * Sensitive data handling — `%variable%` placeholder substitution.
 *
 * Secrets are stored locally and substituted into actions at execution time.
 * The LLM only sees `%variable_name%` placeholders — the actual values never
 * cross the network to the LLM provider.
 *
 * Usage:
 *   1. User stores secrets: `setSecret("email", "user@example.com")`
 *   2. User prompt: `"Log in with my email %email% and password %password%"`
 *   3. The LLM sees the prompt verbatim (placeholders intact).
 *   4. When the LLM emits `input(text="%email%")`, the executor substitutes
 *      the real value at the last moment via {@link substituteSecrets} — the
 *      LLM never sees the real value.
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
export async function listSecrets(): Promise<SecretEntry[]> {
  if (isExtensionWithSession()) {
    try {
      const res = await chrome.storage.session.get(STORAGE_KEY);
      return (res[STORAGE_KEY] as SecretEntry[]) || [];
    } catch (e) {
      // A real storage error must NOT be silently treated as "no secrets" —
      // callers rely on the distinction (e.g. redactSecrets must not return
      // unredacted text on a read failure). Surface it and let callers decide.
      console.error("[secrets] chrome.storage.session.get failed:", e);
      throw e;
    }
  }
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as SecretEntry[];
  } catch {
    return [];
  }
}

/**
 * Create or update a secret. If a secret with the same name exists, it is
 * replaced; otherwise the new entry is appended.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = await listSecrets();
    const idx = secrets.findIndex((s) => s.name === name);
    const entry: SecretEntry = { name, value, createdAt: Date.now() };
    if (idx >= 0) secrets[idx] = entry;
    else secrets.push(entry);
    await persist(secrets);
  });
}

/** Delete the secret with the given name (no-op if it doesn't exist). */
export async function deleteSecret(name: string): Promise<void> {
  return withSecretLock(async () => {
    const secrets = (await listSecrets()).filter((s) => s.name !== name);
    await persist(secrets);
  });
}

/**
 * Substitute `%variable%` placeholders in a string with the actual secret
 * values. Called at action-execution time so the LLM never sees real values.
 *
 * Unknown placeholders are left intact (so they remain visible in error
 * messages). A storage read failure leaves the placeholders intact (the
 * documented behavior) rather than throwing into the executor.
 */
export async function substituteSecrets(text: string): Promise<string> {
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
    console.warn("[secrets] substituteSecrets: could not load secrets; leaving placeholders intact:", e);
    return text;
  }
  const map = new Map(secrets.map((s) => [s.name, s.value]));
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
  let secrets: SecretEntry[];
  try {
    secrets = await listSecrets();
  } catch (e) {
    // If we can't load the secret store, we MUST NOT return `text` unchanged —
    // that would leak unredacted secrets into logs. Mask the whole line instead.
    console.warn("[secrets] redactSecrets: could not load secrets; masking output to avoid leak:", e);
    return "[REDACTED: secret store unavailable]";
  }
  const eligible = secrets
    // `>= MIN_REDACTABLE_LENGTH` (now 0) keeps every real secret; the
    // extra `> 0` guard only drops empty values that would break the regex.
    .filter((s) => s.value.length >= MIN_REDACTABLE_LENGTH && s.value.length > 0)
    // Sort longest-first so a secret that's a prefix of another doesn't mask it.
    .sort((a, b) => b.value.length - a.value.length);
  if (eligible.length === 0) return text;

  // Build a single alternation regex, escaping each value for regex safety.
  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(eligible.map((s) => escapeRegex(s.value)).join("|"), "g");
  // Build a value→name lookup so the replacer can pick the right marker.
  // (If two secrets share a value, the first in the sorted array wins.)
  const valueToName = new Map<string, string>();
  for (const s of eligible) {
    if (!valueToName.has(s.value)) valueToName.set(s.value, s.name);
  }
  return text.replace(pattern, (match) => `[REDACTED:${valueToName.get(match) ?? "unknown"}]`);
}
