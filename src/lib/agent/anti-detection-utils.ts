export const BLOCKED_PAGE_RE = /cannot access|can'?t access|chrome:\/\/|about:|edge:\/\/|not allowed|not permitted|forbidden/i;

const STEALTH_ENABLED_KEY = "stealthEnabled";

export async function isStealthEnabled(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(STEALTH_ENABLED_KEY);
    return res[STEALTH_ENABLED_KEY] === true;
  } catch {
    return false;
  }
}
