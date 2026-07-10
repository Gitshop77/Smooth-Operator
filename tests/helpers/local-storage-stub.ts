/**
 * `installLocalStorageStub` — install a Map-backed `globalThis.localStorage`.
 *
 * jsdom doesn't provide a global `localStorage` by default. Modules that fall
 * back to `localStorage` when `chrome.storage` isn't available (e.g. `secrets`,
 * `persistent-memory`) need this stub installed before they're imported.
 *
 * Was duplicated across three test files:
 *   - `agent-loop-memory.test.ts`
 *   - `security.test.ts`
 *   - `stateful-modules.test.ts`
 *
 * Call `installLocalStorageStub()` in `beforeAll` (or `beforeEach` if you need
 * you want a clean slate between tests in the same file.
 */
export function installLocalStorageStub(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}
