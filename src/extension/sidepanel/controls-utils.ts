const KNOWN_RUNTIME_ERRORS: Record<string, string> = {
  "Could not establish connection. Receiving end does not exist.":
    "Background service unavailable",
  "The message port closed before a response was received.":
    "Background service unavailable",
  "Extension context invalidated.":
    "Extension context invalidated",
};

export function sanitizeLastError(raw: string | undefined): string {
  if (!raw) return "Failed to start";
  return KNOWN_RUNTIME_ERRORS[raw] ?? "Failed to start";
}

// The promise wrappers below read `chrome.runtime.lastError` in the callback
// and reject on failure (mirroring the pattern in options/settings-sync.ts),
// so callers never have to re-check `chrome.runtime.lastError` after `await`.

export function storageGet(keys: string | string[], area: "session" | "local"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    (chrome.storage[area] as { get: (k: string | string[], cb: (r: Record<string, unknown>) => void) => void }).get(keys, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || "chrome.storage.get failed"));
      else resolve(r);
    });
  });
}

export function runtimeSendMessage(msg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: unknown) => {
      if (!chrome.runtime.lastError) { resolve(res); return; }
      const message = chrome.runtime.lastError.message || "";
      // A dead receiver (service worker gone) resolves `undefined` so callers
      // treat it as "no response" instead of crashing on a rejected promise.
      if (KNOWN_RUNTIME_ERRORS[message] === "Background service unavailable") {
        resolve(undefined);
        return;
      }
      reject(new Error(message || "chrome.runtime.sendMessage failed"));
    });
  });
}
