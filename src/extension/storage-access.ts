/**
 * Explicit extension-storage access policy.
 *
 * `storage.session` is trusted-context-only by default, but applying the
 * strongest stable access level on every service-worker incarnation prevents
 * a stale or future widening from silently exposing session credentials to an
 * isolated content world. The caller must await this before credential or run
 * authority reads; rejection is therefore a startup admission failure.
 *
 * `storage.local` is intentionally not changed here. The current extension
 * still has content-world readers for non-secret loader/settings data, and an
 * opt-in remembered API key remains a separately disclosed plaintext-local
 * contract pending the owner decision and compatible migration in Phases 7/11.
 */
export async function restrictSessionStorageToTrustedContexts(
  session: Pick<chrome.storage.StorageArea, "setAccessLevel"> = chrome.storage.session,
): Promise<void> {
  if (!session || typeof session.setAccessLevel !== "function") {
    throw new Error("chrome.storage.session trusted-context restriction is unavailable");
  }
  await session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
