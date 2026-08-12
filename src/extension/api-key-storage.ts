/**
 * Compatibility boundary for callers that still consume provider keys as
 * strings. Persistent keys are owned by the extension-origin credential vault;
 * chrome.storage.local contains only consent plus a non-secret opaque handle.
 */

import {
  migrateRememberedCredential,
  resolveCredential,
  saveEnteredCredential,
} from "./credential-service";
import { decodeCredentialManifest } from "./credential-contract";
import { STORAGE_KEYS } from "./options/storage-keys";

/** Session-first read; remembered credentials hydrate through the vault. */
export async function ensureApiKeyInSession(): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return "";
  const sres = await chrome.storage.session.get([STORAGE_KEYS.apiKey]);
  const sessionKey = sres[STORAGE_KEYS.apiKey];
  if (typeof sessionKey === "string" && sessionKey.length > 0) return sessionKey;
  if (!chrome.storage?.local) return "";

  const lres = await chrome.storage.local.get([
    STORAGE_KEYS.rememberApiKey,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.credentialManifest,
  ]);
  if (lres[STORAGE_KEYS.rememberApiKey] !== true) return "";
  try {
    // This also performs/resumes the strict legacy plaintext migration.
    const migrated = await migrateRememberedCredential();
    const reference = migrated ?? decodeCredentialManifest(lres[STORAGE_KEYS.credentialManifest]);
    if (!reference) return "";
    const plaintext = await resolveCredential(reference);
    await chrome.storage.session.set({ [STORAGE_KEYS.apiKey]: plaintext });
    const verify = await chrome.storage.session.get([STORAGE_KEYS.apiKey]);
    return verify[STORAGE_KEYS.apiKey] === plaintext ? plaintext : "";
  } catch (error) {
    console.warn("[credentials] remembered credential unavailable:", error);
    return "";
  }
}

/**
 * Apply remember consent. A new opt-in first stages the legacy representation
 * so any vault/write/crash failure retains a recoverable copy; migration only
 * removes it after encrypted and session round-trip verification.
 */
export async function syncRememberedApiKey(
  apiKeyValue: string,
  remember: boolean,
  providerId = "openai",
): Promise<void> {
  await saveEnteredCredential(apiKeyValue, providerId, remember);
}
