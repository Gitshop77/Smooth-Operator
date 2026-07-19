/**
 * F-1 regression coverage: secret substitution/redaction must not run inside a
 * content-script context that cannot read `chrome.storage.session`.
 *
 * A content script is an isolated world where `chrome.storage.session.get`
 * throws "Access to storage is not allowed from this context" (session storage
 * defaults to TRUSTED_CONTEXTS and the extension never calls
 * `setAccessLevel` for content scripts — doing so would arm the `evaluate()`
 * secret-exfil path). Before this fix:
 *  - `substituteSecrets` re-threw on EVERY input action (even placeholder-free),
 *    so typing always failed closed.
 *  - `redactSecrets` returned "[REDACTED: secret store unavailable]", masking
 *    ALL extracted page text.
 *
 * The fix short-circuits `substituteSecrets` when the text has no `%placeholder%`
 * (no store read at all) and makes both functions no-ops in the content script
 * when the trusted service worker has already resolved secrets
 * (`setSecretsResolvedExternally(true)`). The SW resolves + redacts instead.
 *
 * These tests pin that behavior and that the demo (non-extension, localStorage)
 * path keeps substituting/redacting, and that a readable-session (service
 * worker) context still substitutes + redacts correctly.
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "vitest";
import {
  substituteSecrets,
  redactSecrets,
  setSecretsResolvedExternally,
} from "../src/lib/agent/secrets";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

const CONTENT_SCRIPT_ERROR = "Access to storage is not allowed from this context";

function installThrowingSessionStub(): void {
  // `isExtensionWithSession()` returns true (session API present), but the
  // actual read throws exactly like a real content script.
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: () => Promise.reject(new Error(CONTENT_SCRIPT_ERROR)),
      },
    },
  };
}

function installReadableSessionStub(): void {
  // Simulate the trusted service-worker context, where session reads succeed.
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: (key: string) =>
          Promise.resolve({
            [key]: [
              { name: "email", value: "user@example.com", createdAt: Date.now() },
              { name: "pw", value: "hunter2", createdAt: Date.now() },
            ],
          }),
      },
    },
  };
}

function clearChromeStub(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}

afterEach(() => {
  clearChromeStub();
  setSecretsResolvedExternally(false);
  // Drop any secrets seeded directly into localStorage by the demo tests.
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("F-1: content-script context must not fail on placeholder-free input", () => {
  test("substituteSecrets short-circuits (no store read) for placeholder-free text even though session.get throws", async () => {
    installThrowingSessionStub();
    // `isExtensionWithSession()` is now true, so the throwing session.get would
    // have been reached — but the no-placeholder short-circuit must prevent it.
    const out = await substituteSecrets("just some plain text to type");
    expect(out).toBe("just some plain text to type");
  });

  test("substituteSecrets still fails closed (throws) for a real placeholder when the store is unreadable", async () => {
    installThrowingSessionStub();
    await expect(substituteSecrets("email is %email%", { trusted: true })).rejects.toThrow(CONTENT_SCRIPT_ERROR);
  });

  test("redactSecrets is a no-op (no throw) once the SW resolved secrets, even though session.get throws", async () => {
    installThrowingSessionStub();
    setSecretsResolvedExternally(true);
    const out = await redactSecrets("page text containing a secret value");
    expect(out).toBe("page text containing a secret value");
  });
});

describe("F-1: service-worker context (readable session) substitutes + redacts", () => {
  test("substituteSecrets resolves a placeholder from session storage", async () => {
    installReadableSessionStub();
    const out = await substituteSecrets("email is %email%", { trusted: true });
    expect(out).toBe("email is user@example.com");
  });

  test("redactSecrets redacts a stored secret value from session storage", async () => {
    installReadableSessionStub();
    const out = await redactSecrets("password hunter2 here");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED:pw]");
  });
});

describe("F-1: demo / non-extension path (localStorage) is unaffected", () => {
  beforeAll(() => {
    installLocalStorageStub();
  });
  afterAll(() => {
    restoreLocalStorageStub();
  });

  test("substituteSecrets substitutes a placeholder from localStorage when chrome is absent", async () => {
    clearChromeStub();
    localStorage.setItem(
      "open_cowork_secrets",
      JSON.stringify([{ name: "email", value: "user@example.com", createdAt: Date.now() }]),
    );
    const out = await substituteSecrets("email is %email%", { trusted: true });
    expect(out).toBe("email is user@example.com");
  });

  test("redactSecrets redacts a stored secret value from localStorage when chrome is absent", async () => {
    clearChromeStub();
    localStorage.setItem(
      "open_cowork_secrets",
      JSON.stringify([{ name: "pw", value: "hunter2", createdAt: Date.now() }]),
    );
    const out = await redactSecrets("the password is hunter2 ok");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED:pw]");
  });
});
