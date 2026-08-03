/**
 * Shared chrome.storage mock for tests.
 *
 * provider-config-ui.ts runs `.then()` on `chrome.storage.local.get()` at
 * import time — the mock must return a Promise, not invoke a callback only.
 * Centralising the mock here prevents every test file from reinventing it
 * (and getting it wrong after an agent "simplifies" it back to callback-only).
 */

export function makeChromeStorageMock(
  localStore: Map<string, unknown>,
  sessionStore: Map<string, unknown>,
) {
  const makeArea = (store: Map<string, unknown>) => ({
    get: (keysOrCb?: unknown, cb?: (res: Record<string, unknown>) => void) => {
      // Mirror the real chrome.storage contract: only the REQUESTED keys are
      // returned, so a source that reads a key it never requested (or that
      // relies on defaults) is caught by its consumers. Shapes:
      //   get() / get(null) / get(undefined)      → all keys
      //   get("key")                              → that key only
      //   get(["k1","k2"])                        → those keys only
      //   get({ k1: fallback })                   → keys with defaults
      //   get(cb)                                 → callback receives all keys
      const all = Object.fromEntries(store);
      let result: Record<string, unknown>;
      if (keysOrCb === undefined || keysOrCb === null || typeof keysOrCb === "function") {
        result = { ...all };
      } else if (typeof keysOrCb === "string") {
        result = keysOrCb in all ? { [keysOrCb]: all[keysOrCb] } : {};
      } else if (Array.isArray(keysOrCb)) {
        result = {};
        for (const k of keysOrCb) if (k in all) result[k] = all[k];
      } else if (typeof keysOrCb === "object") {
        result = {};
        for (const [k, fallback] of Object.entries(keysOrCb)) {
          result[k] = k in all ? all[k] : fallback;
        }
      } else {
        // Unknown key selector — never fall back to returning everything.
        result = {};
      }
      if (typeof keysOrCb === "function") {
        keysOrCb(result);
        return Promise.resolve(result);
      }
      cb?.(result);
      return Promise.resolve(result);
    },
    set: (items: Record<string, unknown>, cb?: () => void) => {
      Object.entries(items).forEach(([k, v]) => store.set(k, v));
      cb?.();
      return Promise.resolve();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
      cb?.();
      return Promise.resolve();
    },
    clear: (cb?: () => void) => {
      store.clear();
      cb?.();
      return Promise.resolve();
    },
  });
  return {
    storage: {
      local: makeArea(localStore),
      session: makeArea(sessionStore),
    },
    runtime: {
      lastError: undefined,
      id: "test",
      getManifest: () => ({ permissions: [] as string[], host_permissions: [] as string[] }),
      onMessage: { addListener: () => {} },
      sendMessage: (_msg: unknown, cb?: (res: unknown) => void) => {
        cb?.(undefined);
      },
    },
  };
}
