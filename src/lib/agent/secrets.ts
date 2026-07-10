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
 * Regex matching `%identifier%` placeholders.
 *
 * Tightened: the identifier must START with a letter (not underscore, which
 * collided with %-formatted system strings like %_foo_%). Original was
 * `/%[a-zA-Z_][a-zA-Z0-9_]*%/g`.
 */
const PLACEHOLDER_PATTERN = /%([a-zA-Z][a-zA-Z0-9_]*)%/g;

/** Minimum secret length eligible for redaction (avoids redacting tiny common strings). */
const MIN_REDACTABLE_LENGTH = 4;

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
      console.error("[secrets] chrome.storage.session.get failed:", e);
      return [];
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
  const secrets = await listSecrets();
  const idx = secrets.findIndex((s) => s.name === name);
  const entry: SecretEntry = { name, value, createdAt: Date.now() };
  if (idx >= 0) secrets[idx] = entry;
  else secrets.push(entry);
  await persist(secrets);
}

/** Delete the secret with the given name (no-op if it doesn't exist). */
export async function deleteSecret(name: string): Promise<void> {
  const secrets = (await listSecrets()).filter((s) => s.name !== name);
  await persist(secrets);
}

/**
 * Substitute `%variable%` placeholders in a string with the actual secret
 * values. Called at action-execution time so the LLM never sees real values.
 *
 * Unknown placeholders are left intact (so they remain visible in error
 * messages).
 */
export async function substituteSecrets(text: string): Promise<string> {
  const secrets = await listSecrets();
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
 * secret's value is a prefix of another). Secrets shorter than
 * {@link MIN_REDACTABLE_LENGTH} are skipped to avoid redacting common short
 * strings like "ok".
 */
export async function redactSecrets(text: string): Promise<string> {
  const secrets = await listSecrets();
  const eligible = secrets
    .filter((s) => s.value.length >= MIN_REDACTABLE_LENGTH)
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
