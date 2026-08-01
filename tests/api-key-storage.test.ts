import { describe, test, expect, beforeEach } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";

let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;

function setupChrome(): void {
  localStore = new Map<string, unknown>();
  sessionStore = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(localStore, sessionStore);
}

describe("api-key-storage policy", () => {
  let ensureApiKeyInSession: () => Promise<string>;
  let syncRememberedApiKey: (key: string, remember: boolean) => Promise<void>;

  beforeEach(async () => {
    setupChrome();
    const mod = await import("../src/extension/api-key-storage");
    ensureApiKeyInSession = mod.ensureApiKeyInSession;
    syncRememberedApiKey = mod.syncRememberedApiKey;
  });

  test("returns the session key when present, without touching local", async () => {
    sessionStore.set("apiKey", "sk-session");
    expect(await ensureApiKeyInSession()).toBe("sk-session");
    expect(localStore.size).toBe(0);
  });

  test("re-hydrates from local when consent flag is set and session is empty", async () => {
    localStore.set("rememberApiKey", true);
    localStore.set("apiKey", "sk-remembered");
    expect(await ensureApiKeyInSession()).toBe("sk-remembered");
    expect(sessionStore.get("apiKey")).toBe("sk-remembered");
  });

  test("does NOT trust a local key without the consent flag", async () => {
    localStore.set("apiKey", "sk-local-no-consent");
    expect(await ensureApiKeyInSession()).toBe("");
    expect(sessionStore.size).toBe(0);
  });

  test("does NOT trust a truthy-but-not-exactly-true consent flag", async () => {
    localStore.set("rememberApiKey", 1);
    localStore.set("apiKey", "sk-local-truthy-flag");
    expect(await ensureApiKeyInSession()).toBe("");
    expect(sessionStore.size).toBe(0);
  });

  test("returns empty when consent is set but no local key exists", async () => {
    localStore.set("rememberApiKey", true);
    expect(await ensureApiKeyInSession()).toBe("");
  });

  test("syncRememberedApiKey(true, key) writes key + flag to local", async () => {
    await syncRememberedApiKey("sk-new", true);
    expect(localStore.get("apiKey")).toBe("sk-new");
    expect(localStore.get("rememberApiKey")).toBe(true);
  });

  test("syncRememberedApiKey(false) removes key and clears flag", async () => {
    localStore.set("apiKey", "sk-old");
    localStore.set("rememberApiKey", true);
    await syncRememberedApiKey("sk-old", false);
    expect(localStore.has("apiKey")).toBe(false);
    expect(localStore.get("rememberApiKey")).toBe(false);
  });

  test("syncRememberedApiKey(true, \"\") does not store an empty key", async () => {
    await syncRememberedApiKey("", true);
    expect(localStore.has("apiKey")).toBe(false);
    expect(localStore.get("rememberApiKey")).toBe(false);
  });

  test("does NOT hydrate a non-string local mirror value", async () => {
    localStore.set("rememberApiKey", true);
    localStore.set("apiKey", 12345);
    expect(await ensureApiKeyInSession()).toBe("");
    expect(sessionStore.size).toBe(0);
  });

  test("does NOT hydrate a truthy non-string session value", async () => {
    sessionStore.set("apiKey", 12345);
    expect(await ensureApiKeyInSession()).toBe("");
    expect(sessionStore.size).toBe(1);
  });

  test("returns empty when chrome is unavailable", async () => {
    const chrome = (globalThis as unknown as { chrome?: unknown }).chrome;
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    try {
      expect(await ensureApiKeyInSession()).toBe("");
      await syncRememberedApiKey("sk-x", true);
    } finally {
      (globalThis as unknown as { chrome?: unknown }).chrome = chrome;
    }
  });

  test("returns empty when storage.local is unavailable", async () => {
    const mock = (globalThis as unknown as { chrome: { storage: { local?: unknown } } }).chrome;
    const local = mock.storage.local;
    mock.storage.local = undefined;
    try {
      expect(await ensureApiKeyInSession()).toBe("");
    } finally {
      mock.storage.local = local;
    }
  });
});
