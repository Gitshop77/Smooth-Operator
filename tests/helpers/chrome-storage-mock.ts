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
      const result = Object.fromEntries(store);
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
