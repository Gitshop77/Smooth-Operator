/**
 * Lifecycle coverage for external invalidation of module-level caches.
 *
 * - secrets: a `chrome.storage.onChanged` listener for the session-area
 *   `open_cowork_secrets` key must clear `secretsCache`, drop
 *   `redactionCache`, and bump `secretSetVersion`, so a service worker picks
 *   up secret writes made by the options page (its own module instance) and
 *   redacts/substitutes against the fresh set.
 * - persistent memory: the storage key follows the `open_cowork_` prefix
 *   convention, and a cross-tab `storage` event (localStorage path) must
 *   invalidate the memory caches.
 *
 * The secrets module registers its `chrome.storage.onChanged` listener at
 * module load time, so each test installs the chrome stub BEFORE dynamically
 * importing it via `vi.resetModules()`.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import {
  saveMemory,
  loadAllMemories,
  getMemoriesForUrl,
} from "../src/lib/agent/persistent-memory";
import {
  installLocalStorageStub,
  restoreLocalStorageStub,
} from "./helpers";

const SECRETS_KEY = "open_cowork_secrets";
const MEMORY_KEY = "open_cowork_site_memories";

interface ChromeStub {
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: {
      addListener(fn: (changes: Record<string, unknown>, area: string) => void): void;
    };
  };
}

function installChromeWithSession(onChangedListeners: Array<(changes: Record<string, unknown>, area: string) => void>): {
  sessionStore: Map<string, unknown>;
} {
  const sessionStore = new Map<string, unknown>();
  const stub: ChromeStub = {
    storage: {
      session: {
        get: (key: string) => Promise.resolve({ [key]: sessionStore.get(key) }),
        set: (items: Record<string, unknown>) => {
          Object.entries(items).forEach(([k, v]) => sessionStore.set(k, v));
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn) => onChangedListeners.push(fn),
      },
    },
  };
  (globalThis as { chrome?: ChromeStub }).chrome = stub;
  return { sessionStore };
}

function clearChromeStub(): void {
  delete (globalThis as { chrome?: ChromeStub }).chrome;
}

function fireSessionChange(listeners: Array<(changes: Record<string, unknown>, area: string) => void>, changes: Record<string, unknown>): void {
  listeners.forEach((fn) => fn(changes, "session"));
}

afterEach(() => {
  clearChromeStub();
});

describe("secrets: external writes invalidate the SW caches", () => {
  test("onChanged for open_cowork_secrets clears caches and bumps the version", async () => {
    vi.resetModules();
    const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
    const { sessionStore } = installChromeWithSession(listeners);
    const { setSecret, redactSecrets, getSecretSetVersion } = await import("../src/lib/agent/secrets");

    const v0 = getSecretSetVersion();
    await setSecret("pw", "hunter2");
    expect(getSecretSetVersion()).toBe(v0 + 1);

    // Warm both caches with the current secret set.
    expect(await redactSecrets("password hunter2")).toContain("[REDACTED:pw]");

    // The options page (its own module instance) writes a new value.
    const fresh = [{ name: "pw", value: "new-secret", createdAt: Date.now() }];
    sessionStore.set(SECRETS_KEY, fresh);
    fireSessionChange(listeners, { [SECRETS_KEY]: { newValue: fresh } });

    expect(getSecretSetVersion()).toBe(v0 + 2);
    const out = await redactSecrets("hunter2 new-secret");
    expect(out).toContain("hunter2"); // stale value is no longer known
    expect(out).not.toContain("new-secret");
    expect(out).toContain("[REDACTED:pw]");
  });

  test("substituteSecrets resolves the externally-updated value after invalidation", async () => {
    vi.resetModules();
    const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
    const { sessionStore } = installChromeWithSession(listeners);
    const { setSecret, substituteSecrets } = await import("../src/lib/agent/secrets");

    await setSecret("email", "old@example.com");
    expect(await substituteSecrets("contact %email%", { trusted: true })).toBe("contact old@example.com");

    const fresh = [{ name: "email", value: "new@example.com", createdAt: Date.now() }];
    sessionStore.set(SECRETS_KEY, fresh);
    fireSessionChange(listeners, { [SECRETS_KEY]: { newValue: fresh } });

    expect(await substituteSecrets("contact %email%", { trusted: true })).toBe("contact new@example.com");
  });

  test("onChanged for unrelated keys or areas does not invalidate", async () => {
    vi.resetModules();
    const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
    const { sessionStore } = installChromeWithSession(listeners);
    const { setSecret, redactSecrets, getSecretSetVersion } = await import("../src/lib/agent/secrets");

    const v0 = getSecretSetVersion();
    await setSecret("pw", "hunter2");
    expect(await redactSecrets("password hunter2")).toContain("[REDACTED:pw]");

    // Unrelated key in session, and the secrets key in the local area.
    fireSessionChange(listeners, { some_other_key: { newValue: 1 } });
    listeners.forEach((fn) => fn({ [SECRETS_KEY]: { newValue: [] } }, "local"));

    expect(getSecretSetVersion()).toBe(v0 + 1); // unchanged by unrelated events
    expect(await redactSecrets("password hunter2")).toContain("[REDACTED:pw]");

    // A store write WITHOUT the event must stay invisible (cache is frozen).
    sessionStore.set(SECRETS_KEY, [{ name: "pw", value: "new-secret", createdAt: Date.now() }]);
    expect(await redactSecrets("hunter2")).toContain("[REDACTED:pw]");
  });
});

describe("persistent memory: storage key convention and cross-tab invalidation", () => {
  beforeAll(() => {
    installLocalStorageStub();
  });
  afterAll(() => {
    restoreLocalStorageStub();
  });

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  test("memory storage key follows the open_cowork_ prefix convention", async () => {
    await saveMemory("github.com", "note");
    expect(localStorage.getItem(MEMORY_KEY)).not.toBeNull();
    expect(localStorage.getItem("__opencowork_site_memories")).toBeNull();
  });

  test("a cross-tab storage event invalidates the memory cache", async () => {
    await saveMemory("github.com", "old note");
    // Warm the caches.
    expect((await getMemoriesForUrl("https://github.com/foo"))[0].notes).toBe("old note");
    expect((await loadAllMemories())["github.com"].notes).toBe("old note");

    // Another tab writes the same key and fires the storage event.
    const fresh = JSON.stringify({
      "github.com": { domain: "github.com", notes: "new note", updatedAt: Date.now() },
    });
    localStorage.setItem(MEMORY_KEY, fresh);
    window.dispatchEvent(new StorageEvent("storage", { key: MEMORY_KEY, newValue: fresh }));

    expect((await getMemoriesForUrl("https://github.com/foo"))[0].notes).toBe("new note");
    expect((await loadAllMemories())["github.com"].notes).toBe("new note");
  });

  test("unrelated storage events do not invalidate the memory cache", async () => {
    await saveMemory("github.com", "note");
    expect((await getMemoriesForUrl("https://github.com/foo"))[0].notes).toBe("note");

    localStorage.setItem(SECRETS_KEY, JSON.stringify([]));
    window.dispatchEvent(new StorageEvent("storage", { key: SECRETS_KEY, newValue: "[]" }));

    expect((await getMemoriesForUrl("https://github.com/foo"))[0].notes).toBe("note");
  });
});
