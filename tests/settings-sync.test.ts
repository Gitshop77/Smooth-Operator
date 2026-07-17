/**
 * Domain / cockpit-URL validators in `options/settings-sync.ts`.
 *
 * `settings-sync.ts` runs storage + DOM side-effects at import time (it builds
 * the provider <select> and wires load handlers), so we stub `chrome` and set
 * up the minimal element set before the dynamic import.
 */

import { describe, test, expect, beforeAll, vi } from "vitest";

// Inspectable storage maps, (re)assigned by setupGlobals so tests can assert
// what saveSettings() persisted.
let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;

function setupGlobals(): void {
  localStore = new Map<string, unknown>();
  sessionStore = new Map<string, unknown>();
  const makeArea = (store: Map<string, unknown>) => ({
    get: (_keys: unknown, cb?: (res: Record<string, unknown>) => void) => {
      cb?.(Object.fromEntries(store));
    },
    set: (items: Record<string, unknown>, cb?: () => void) => {
      Object.entries(items).forEach(([k, v]) => store.set(k, v));
      cb?.();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
      cb?.();
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: makeArea(localStore), session: makeArea(sessionStore) },
    runtime: { lastError: undefined, id: "test" },
  };

  // Elements touched during import-time load + updateProviderUI.
  document.body.innerHTML = `
    <select id="provider"></select>
    <button id="testConnection"></button>
    <input id="model">
    <span id="provider-hint"></span>
    <input id="apiKey">
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
    <input id="maxSteps">
    <input id="maxActions">
    <input id="plannerInterval">
    <input id="maxFailures">
    <input id="costCap">
    <textarea id="defaultTask"></textarea>
    <input id="screenshotQuality">
    <input id="enableScreenshots">
    <input type="checkbox" id="enableStealth" />
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <input id="cockpitUrl">
    <input id="notifyOnCompletion">
    <input id="notifyOnError">
    <input id="notifyOnTakeover">
    <input id="webhookUrl">
    <div id="saved"></div>
    <button id="addSecret"></button>
    <input id="secretName">
    <input id="secretValue">
    <div id="secretsList"></div>
  `;
}

describe("settings-sync URL/hostname validators", () => {
  let isHttpUrl: (v: string) => boolean;
  let isHostname: (v: string) => boolean;
  let readInt: (id: string, def: number, min: number, max: number, invalid: string[]) => number;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    isHttpUrl = mod.isHttpUrl;
    isHostname = mod.isHostname;
    readInt = mod.readInt;
  });

  test("isHttpUrl accepts http(s) and rejects others", () => {
    expect(isHttpUrl("http://x")).toBe(true);
    expect(isHttpUrl("https://x")).toBe(true);
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false); // non-http(s) scheme
  });

  test("isHostname accepts bare hostnames incl. IPv6, rejects scheme/port/path", () => {
    expect(isHostname("2001:db8::1")).toBe(true); // IPv6 literal
    expect(isHostname("evil.com:9999")).toBe(false); // host:port
    expect(isHostname("EXAMPLE.com")).toBe(true); // IDN/uppercase
    expect(isHostname("*.example.com")).toBe(true); // wildcard
    expect(isHostname("a/b")).toBe(false); // path
    expect(isHostname("http://x.com")).toBe(false); // scheme
    expect(isHostname("gggg::")).toBe(false); // non-hex IPv6-ish
    expect(isHostname("fe80::1%eth0")).toBe(false); // IPv6 zone-id must be rejected
  });

  test("readInt rejects trailing junk and resets to default", () => {
    const el = document.getElementById("maxSteps") as HTMLInputElement;
    el.value = "5abc"; // trailing junk: parseInt("5abc") -> 5 but must be rejected
    const invalid: string[] = [];
    const result = readInt("maxSteps", 100, 1, 500, invalid);
    expect(result).toBe(100); // default
    expect(invalid).toContain("maxSteps");
    expect(el.value).toBe("100"); // reset to default
  });
});

describe("settings-sync stealthEnabled serialization", () => {
  // `stealthEnabled` is read at load (settings-sync.ts:167), written at save
  // (settings-sync.ts:389) and listed in the serialized keys (settings-sync.ts:465),
  // but no test exercised its round-trip. A regression dropping the field from
  // serialization/restore would otherwise pass silently. The stealth DEFAULT-OFF
  // guard itself is intact — we only verify the field survives save/load.

  test("saveSettings persists the enableStealth checkbox as a strict boolean", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("enableStealth") as HTMLInputElement;
    cb.checked = true;
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("stealthEnabled")).toBe(true);
    // DEFAULT-OFF guard: an unchecked box must persist exactly `false`, never a
    // truthy-but-non-true value that isStealthEnabled() would also reject.
    cb.checked = false;
    await mod.saveSettings();
    expect(localStore.get("stealthEnabled")).toBe(false);
  });

  test("import-time load reflects a restored stealthEnabled=true as a checked box", async () => {
    setupGlobals();
    // Seed the persisted flag BEFORE the module's import-time load callback runs.
    localStore.set("stealthEnabled", true);
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("enableStealth") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });
});
