/**
 * Lightpanda research settings — read from chrome.storage.local.
 * The key strings MUST match the STORAGE_KEYS entries in
 * src/extension/options/storage-keys.ts (Task 6 Step 11).
 */

export const LIGHTPANDA_STORAGE_KEYS = {
  enabled: "lightpandaEnabled",
  binaryPath: "lightpandaBinaryPath",
  braveKey: "lightpandaBraveKey",
  tavilyKey: "lightpandaTavilyKey",
  timeoutSeconds: "lightpandaTimeoutSeconds",
  maxResultChars: "lightpandaMaxResultChars",
} as const;

export interface LightpandaSettings {
  enabled: boolean;
  binaryPath: string;
  braveKey: string;
  tavilyKey: string;
  timeoutMs: number;
  maxResultChars: number;
}

export const LIGHTPANDA_DEFAULTS: LightpandaSettings = {
  enabled: true,
  binaryPath: "",
  braveKey: "",
  tavilyKey: "",
  timeoutMs: 120_000,
  maxResultChars: 32_000,
};

/** Hard ceiling for the settings timeout — the content RPC backstop must exceed it (660s). */
export const LIGHTPANDA_MAX_TIMEOUT_MS = 600_000;
export const LIGHTPANDA_MAX_RESULT_CHARS = 128_000;

export async function readLightpandaSettings(): Promise<LightpandaSettings> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { ...LIGHTPANDA_DEFAULTS };
  const stored = await chrome.storage.local.get(Object.values(LIGHTPANDA_STORAGE_KEYS));
  const timeoutSeconds = Number(stored[LIGHTPANDA_STORAGE_KEYS.timeoutSeconds]);
  const maxResultChars = Number(stored[LIGHTPANDA_STORAGE_KEYS.maxResultChars]);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    enabled: stored[LIGHTPANDA_STORAGE_KEYS.enabled] !== false,
    binaryPath: str(stored[LIGHTPANDA_STORAGE_KEYS.binaryPath]),
    braveKey: str(stored[LIGHTPANDA_STORAGE_KEYS.braveKey]),
    tavilyKey: str(stored[LIGHTPANDA_STORAGE_KEYS.tavilyKey]),
    timeoutMs:
      Number.isFinite(timeoutSeconds) && timeoutSeconds >= 10
        ? Math.min(Math.round(timeoutSeconds) * 1000, LIGHTPANDA_MAX_TIMEOUT_MS)
        : LIGHTPANDA_DEFAULTS.timeoutMs,
    maxResultChars:
      Number.isFinite(maxResultChars) && maxResultChars > 0
        ? Math.min(Math.round(maxResultChars), LIGHTPANDA_MAX_RESULT_CHARS)
        : LIGHTPANDA_DEFAULTS.maxResultChars,
  };
}
