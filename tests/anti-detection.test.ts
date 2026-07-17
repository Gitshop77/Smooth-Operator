/**
 * anti-detection.ts — stealth-patch regression tests.
 *
 * The 13 patches in `stealthScriptBody` are injected verbatim into a page's
 * MAIN world via chrome.scripting. We can't run chrome.scripting here, but the
 * script is just a self-contained IIFE that touches `navigator` / `window` /
 * `screen` / `console` (and WebGL / Notification when present).
 *
 * These tests run the *serialized* function body in an isolated function scope
 * with a headless-style shim as the only globals. Because the scope is
 * isolated (no access to the module's lexical environment), a patch that
 * accidentally closes over a module-level variable would throw
 * "X is not defined" and fail — so this also guards serialization safety.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { stealthScriptBody, isStealthEnabled } from "../src/lib/agent/anti-detection";

// ─── Opt-in gate (stealthEnabled) ──────────────────────────────────────────
// The 13 MAIN-world patches are ToS-sensitive (bot-detection circumvention) and
// must be OFF unless the user explicitly opts in via chrome.storage.local.
// `isStealthEnabled` is the single source of truth read by ensureContent().

type LocalGet = (keys: string | string[]) => Promise<Record<string, unknown>>;

function mockStorageLocal(getImpl: LocalGet): void {
  vi.stubGlobal("chrome", {
    storage: { local: { get: (keys: string | string[]) => getImpl(keys) } },
  });
}

describe("anti-detection: opt-in gate (stealthEnabled)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test("default (no flag) → disabled", async () => {
    mockStorageLocal(async () => ({}));
    expect(await isStealthEnabled()).toBe(false);
  });

  test("explicit true → enabled", async () => {
    mockStorageLocal(async () => ({ stealthEnabled: true }));
    expect(await isStealthEnabled()).toBe(true);
  });

  test("false / falsy / non-boolean → disabled (fail-safe)", async () => {
    mockStorageLocal(async () => ({ stealthEnabled: false }));
    expect(await isStealthEnabled()).toBe(false);
    mockStorageLocal(async () => ({ stealthEnabled: "true" }));
    expect(await isStealthEnabled()).toBe(false);
    mockStorageLocal(async () => ({ stealthEnabled: 1 }));
    expect(await isStealthEnabled()).toBe(false);
  });

  test("storage unavailable → disabled (fail-safe)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("boom")) } },
    });
    expect(await isStealthEnabled()).toBe(false);
  });
});

type Shim = {
  navigator: Record<string, unknown>;
  window: Record<string, unknown>;
  screen: Record<string, unknown>;
  console: Record<string, unknown>;
  WebGLRenderingContext: unknown;
  WebGL2RenderingContext: unknown;
  Notification: unknown;
};

function buildShim(): Shim {
  const consoleShim: Record<string, unknown> = {};
  for (const n of ["log", "info", "warn", "error", "debug", "table", "trace"]) {
    consoleShim[n] = function () {};
  }
  return {
    navigator: {},
    window: { outerWidth: 0, outerHeight: 0, innerWidth: 1920, innerHeight: 1080 },
    screen: { colorDepth: 0, pixelDepth: 0, width: 1920, height: 1080 },
    console: consoleShim,
    WebGLRenderingContext: undefined,
    WebGL2RenderingContext: undefined,
    Notification: undefined,
  };
}

// Run the serialized body in an isolated function scope. The only names in
// scope are the shim globals + JS built-ins, so a closed-over reference would
// throw a ReferenceError instead of silently succeeding.
function runInIsolation(shim: Shim): void {
  const src = stealthScriptBody.toString();
  const runner = new Function(
    "navigator",
    "window",
    "screen",
    "console",
    "WebGLRenderingContext",
    "WebGL2RenderingContext",
    "Notification",
    "return (" + src + ")();",
  ) as (n: unknown, w: unknown, s: unknown, c: unknown, g: unknown, g2: unknown, nt: unknown) => void;
  runner(
    shim.navigator,
    shim.window,
    shim.screen,
    shim.console,
    shim.WebGLRenderingContext,
    shim.WebGL2RenderingContext,
    shim.Notification,
  );
}

describe("anti-detection: stealth patches apply (headless shim)", () => {
  test("1. navigator.webdriver is overridden to false", () => {
    const shim = buildShim();
    runInIsolation(shim);
    expect(shim.navigator.webdriver).toBe(false);
  });

  test("2. navigator.plugins + mimeTypes populated", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const plugins = shim.navigator.plugins as { length: number };
    const mimeTypes = shim.navigator.mimeTypes as { length: number };
    expect(plugins.length).toBeGreaterThan(0);
    expect(mimeTypes.length).toBeGreaterThan(0);
  });

  test("3. navigator.languages set to a frozen ['en-US','en']", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const langs = shim.navigator.languages as readonly string[];
    expect(langs).toEqual(["en-US", "en"]);
    expect(Object.isFrozen(langs)).toBe(true);
    expect(shim.navigator.language).toBe("en-US");
  });

  test("4. window.chrome.runtime stub installed", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const chrome = shim.window.chrome as { runtime?: Record<string, unknown> };
    expect(chrome).toBeTruthy();
    expect(chrome.runtime).toBeTruthy();
    expect(typeof chrome.runtime!.connect).toBe("function");
  });

  test("5. permissions.query returns Notification.permission for notifications", () => {
    const shim = buildShim();
    const query = function () {
      return Promise.resolve({ state: "prompt" });
    };
    shim.navigator.permissions = { query };
    const Notification = function () {} as unknown as Record<string, unknown>;
    Notification.permission = "denied";
    shim.Notification = Notification;
    runInIsolation(shim);
    const patched = shim.navigator.permissions as {
      query: (p: { name: string }) => Promise<{ state: string }>;
    };
    return patched.query({ name: "notifications" }).then((st) => {
      // Patch 7 coerces a "denied" Notification.permission to "default" before
      // query reads it, so notifications reports the coerced value.
      expect(st.state).toBe("default");
    });
  });

  test("6. WebGL vendor/renderer spoofed for 0x9245/0x9246", () => {
    const shim = buildShim();
    const proto = {
      getParameter(p: number) {
        return "Google SwiftShader";
      },
    };
    shim.WebGLRenderingContext = { prototype: proto };
    shim.WebGL2RenderingContext = { prototype: { ...proto } };
    runInIsolation(shim);
    const glProto = (shim.WebGLRenderingContext as { prototype: { getParameter: (p: number) => string } })
      .prototype;
    const gl2Proto = (shim.WebGL2RenderingContext as { prototype: { getParameter: (p: number) => string } })
      .prototype;
    expect(glProto.getParameter(0x9245)).toBe("Intel Inc.");
    expect(glProto.getParameter(0x9246)).toBe("Intel Iris OpenGL Engine");
    expect(gl2Proto.getParameter(0x9245)).toBe("Intel Inc.");
  });

  test("7. Notification.permission coerced from 'denied' to 'default'", () => {
    const shim = buildShim();
    const NotificationCtor = function () {} as unknown as Record<string, unknown>;
    NotificationCtor.permission = "denied";
    shim.Notification = NotificationCtor;
    runInIsolation(shim);
    expect(NotificationCtor.permission).toBe("default");
  });

  test("8. navigator.connection stub installed", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const conn = shim.navigator.connection as { effectiveType: string; rtt: number; downlink: number };
    expect(conn.effectiveType).toBe("4g");
    expect(conn.rtt).toBe(50);
    expect(conn.downlink).toBe(10);
  });

  test("10. console method toString reports native code", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const log = shim.console.log as { toString: () => string };
    expect(log.toString()).toBe("function log() { [native code] }");
  });

  test("11. outerWidth fixed when 0; screen colorDepth/pixelDepth fixed when 0", () => {
    const shim = buildShim();
    runInIsolation(shim);
    expect((shim.window.outerWidth as number) > 0).toBe(true);
    expect((shim.window.outerHeight as number) > 0).toBe(true);
    expect(shim.screen.colorDepth).toBe(24);
    expect(shim.screen.pixelDepth).toBe(24);
  });

  test("12. navigator.hardwareConcurrency defaults to 4", () => {
    const shim = buildShim();
    runInIsolation(shim);
    expect(shim.navigator.hardwareConcurrency).toBe(4);
  });

  test("13. navigator.deviceMemory defaults to 8", () => {
    const shim = buildShim();
    runInIsolation(shim);
    expect(shim.navigator.deviceMemory).toBe(8);
  });
});

describe("anti-detection: serialization safety", () => {
  test("serialized body runs with no free (module-scope) identifiers", () => {
    const shim = buildShim();
    expect(() => runInIsolation(shim)).not.toThrow();
  });

  test("serialized body is a self-contained function (no import/require)", () => {
    const src = stealthScriptBody.toString();
    expect(src).not.toMatch(/^\s*import\s/);
    expect(src).not.toMatch(/require\s*\(/);
    expect(src).toContain("use strict");
  });
});
