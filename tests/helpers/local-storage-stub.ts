/**
 * `installLocalStorageStub` — install a Map-backed `globalThis.localStorage`.
 *
 * jsdom doesn't provide a global `localStorage` by default. Modules that fall
 * back to `localStorage` when `chrome.storage` isn't available (e.g. `secrets`,
 * `persistent-memory`) need this stub installed before they're imported.
 *
 * Was duplicated across three test files:
 * - `agent-loop-memory.test.ts`
 * - `security.test.ts`
 * - `stateful-modules.test.ts`
 *
 * Call `installLocalStorageStub()` in `beforeAll` (or `beforeEach`) if you want
 * a clean slate between tests in the same file.
 *
 * IMPORTANT: `installLocalStorageStub` overwrites the global `localStorage`,
 * which otherwise leaks into every subsequent test file in the same worker.
 * Pair it with `restoreLocalStorageStub()` (in `afterEach`/`afterAll`) to put
 * the original global back. `installLocalStorageStub` also returns a restore
 * function for convenience.
 */
type GlobalWithLocalStorage = { localStorage?: Storage };

let savedDescriptor: PropertyDescriptor | undefined;
let hadDescriptor = false;

export function installLocalStorageStub(): () => void {
 // Capture the pre-existing global ONCE so repeated installs don't clobber
 // the true original. If an install already captured it, keep that original —
 // a second install just re-applies the stub on top.
  if (!hadDescriptor) {
    savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    hadDescriptor = savedDescriptor !== undefined;
  }

  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
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
    } as Storage,
    configurable: true,
    writable: true,
    enumerable: true,
  });

  return restoreLocalStorageStub;
}

/**
 * Restore the global `localStorage` to whatever it was before the last
 * `installLocalStorageStub()` call, preventing the stub from leaking across
 * test files. Safe to call even if the stub was never installed.
 */
export function restoreLocalStorageStub(): void {
  if (hadDescriptor && savedDescriptor) {
 // Re-apply the captured original (typically the jsdom-native getter). This
 // is idempotent: calling it after every test keeps `localStorage` present
 // rather than destroying it on the second call.
    Object.defineProperty(globalThis, "localStorage", savedDescriptor);
 // jsdom can surface a non-functional `localStorage` descriptor — when its
 // backing store isn't configured (the `--localstorage-file` warning case),
 // re-applying the descriptor yields an object WITHOUT `setItem`/`getItem`.
 // Restoring to that would silently break every module that falls back to
 // localStorage (secrets, run-history) after the very first test. If the
 // restored store isn't functional, keep the stub instead so dependent
 // tests retain a working `localStorage`.
    if (
      typeof (globalThis as GlobalWithLocalStorage).localStorage?.setItem !== "function" ||
      typeof (globalThis as GlobalWithLocalStorage).localStorage?.getItem !== "function"
    ) {
      installLocalStorageStub();
    }
  } else {
    delete (globalThis as GlobalWithLocalStorage).localStorage;
  }
 // NOTE: intentionally do NOT clear `savedDescriptor`/`hadDescriptor` here.
 // Clearing them would make a subsequent `restoreLocalStorageStub()` (e.g. the
 // next test's `afterEach`) fall into the `delete` branch and remove
 // `localStorage` entirely, leaving later tests without it.
}
