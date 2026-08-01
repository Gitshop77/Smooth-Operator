/**
 * API-key storage policy.
 *
 * The provider API key is held in `chrome.storage.session` (in-memory, never
 * written to disk, cleared when the browser closes). Users can OPT IN to
 * persisting it on disk via the "remember on this device" checkbox in
 * Options; this module is the only place that decides where the key lives.
 *
 * - `ensureApiKeyInSession()` is the canonical read path. It returns the
 *   session key if present; otherwise, ONLY when the `rememberApiKey`
 *   consent flag is set, it re-hydrates the session from the local mirror
 *   and returns the key. A plaintext-disk key is never trusted without the
 *   flag.
 * - `syncRememberedApiKey()` applies the checkbox state: opted in → mirror
 *   key + flag to `chrome.storage.local`; opted out → remove the mirror and
 *   clear the flag.
 */

import { STORAGE_KEYS } from "./options/storage-keys";

/** Session-first key read; consent-gated re-hydration from the local mirror. */
export async function ensureApiKeyInSession(): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return "";
  const sres = await chrome.storage.session.get([STORAGE_KEYS.apiKey]);
  const sessionKey = sres[STORAGE_KEYS.apiKey] as string | undefined;
  if (typeof sessionKey === "string" && sessionKey.length > 0) return sessionKey;
  if (!chrome.storage?.local) return "";
  const lres = await chrome.storage.local.get([STORAGE_KEYS.rememberApiKey, STORAGE_KEYS.apiKey]);
  if (lres[STORAGE_KEYS.rememberApiKey] !== true) return "";
  // Reject a non-string mirror value (corrupt/legacy write) instead of
  // forwarding a malformed key downstream. Inline check — normalizeString
  // lives in provider-config.ts, which imports this module (a cycle).
  const localKey = lres[STORAGE_KEYS.apiKey];
  if (typeof localKey !== "string" || localKey.length === 0) return "";
  await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: localKey });
  return localKey;
}

/** Apply the checkbox state to the on-disk mirror + consent flag. */
export async function syncRememberedApiKey(apiKeyValue: string, remember: boolean): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  if (remember && apiKeyValue) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.apiKey]: apiKeyValue,
      [STORAGE_KEYS.rememberApiKey]: true,
    });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
    await chrome.storage.local.set({ [STORAGE_KEYS.rememberApiKey]: false });
  }
}
