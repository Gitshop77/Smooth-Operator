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
import { stealthScriptBody, isStealthEnabled, injectAntiDetection } from "../src/lib/agent/anti-detection";
import {
  isStealthEnabledSync,
  refreshStealthEnabledCache,
  _setStealthEnabledCacheForTests,
} from "../src/lib/agent/anti-detection-utils";

// ─── Stealth gate (stealthEnabled) ────────────────────────────────────────
// The 13 MAIN-world patches are ToS-sensitive (bot-detection circumvention).
// DEFAULT-ON: the product stance is full stealth unless the user explicitly
// opts OUT via chrome.storage.local (`false`). `isStealthEnabled` is the
// single source of truth read by ensureContent().

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

  test("default (no flag) → ENABLED (default-on posture)", async () => {
    mockStorageLocal(async () => ({}));
    expect(await isStealthEnabled()).toBe(true);
  });

  test("explicit true → enabled", async () => {
    mockStorageLocal(async () => ({ stealthEnabled: true }));
    expect(await isStealthEnabled()).toBe(true);
  });

  test("explicit false → disabled (opt-out); non-boolean truthy → enabled", async () => {
    mockStorageLocal(async () => ({ stealthEnabled: false }));
    expect(await isStealthEnabled()).toBe(false);
    // Non-boolean truthy values still enable (only an explicit false opts out).
    mockStorageLocal(async () => ({ stealthEnabled: "true" }));
    expect(await isStealthEnabled()).toBe(true);
    mockStorageLocal(async () => ({ stealthEnabled: 1 }));
    expect(await isStealthEnabled()).toBe(true);
  });

  test("storage unavailable → ENABLED (fail toward stealth — never leak artifacts)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("boom")) } },
    });
    expect(await isStealthEnabled()).toBe(true);
  });
});

describe("anti-detection: sync stealth cache (page-artifact gates)", () => {
  // The cache is module state shared within a test file — reset it so every
  // test starts from the unknown (fail-closed) default.
  beforeEach(() => {
    _setStealthEnabledCacheForTests(null);
  });

  test("unknown (never primed) → ENABLED (artifacts suppressed by default)", () => {
    expect(isStealthEnabledSync()).toBe(true);
  });

  test("_setStealthEnabledCacheForTests(true) enables the sync gate", () => {
    _setStealthEnabledCacheForTests(true);
    expect(isStealthEnabledSync()).toBe(true);
  });

  test("explicit false → disabled", () => {
    _setStealthEnabledCacheForTests(true);
    _setStealthEnabledCacheForTests(false);
    expect(isStealthEnabledSync()).toBe(false);
  });

  test("refreshStealthEnabledCache primes the sync gate from storage", async () => {
    mockStorageLocal(async () => ({ stealthEnabled: true }));
    await expect(refreshStealthEnabledCache()).resolves.toBe(true);
    expect(isStealthEnabledSync()).toBe(true);

    mockStorageLocal(async () => ({ stealthEnabled: false }));
    await expect(refreshStealthEnabledCache()).resolves.toBe(false);
    expect(isStealthEnabledSync()).toBe(false);
  });

  test("refreshStealthEnabledCache fails toward stealth when storage is unavailable", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("boom")) } },
    });
    await expect(refreshStealthEnabledCache()).resolves.toBe(true);
    expect(isStealthEnabledSync()).toBe(true);
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

  test("1b. webdriver lives on Navigator.prototype, NOT as an own instance property (real-Chrome shape)", () => {
    const shim = buildShim();
    // Model a real navigator: an instance that INHERITS Navigator.prototype
    // (plain-object shims take the own-getter fallback instead).
    if (typeof Navigator !== "undefined" && Navigator.prototype) {
      shim.navigator = Object.create(Navigator.prototype) as Record<string, unknown>;
      runInIsolation(shim);
      expect(shim.navigator.webdriver).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(shim.navigator, "webdriver")).toBe(false);
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver");
      expect(desc?.get).toBeTypeOf("function");
      // Cleanup: remove the prototype getter so later tests aren't affected.
      delete (Navigator.prototype as unknown as Record<string, unknown>).webdriver;
    }
  });

  test("2. navigator.plugins + mimeTypes populated", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const plugins = shim.navigator.plugins as { length: number };
    const mimeTypes = shim.navigator.mimeTypes as { length: number };
    expect(plugins.length).toBeGreaterThan(0);
    expect(mimeTypes.length).toBeGreaterThan(0);
  });

  test("2b. fabricated PluginArray/MimeTypeArray stringify as their native tags", () => {
    const shim = buildShim();
    runInIsolation(shim);
    const plugins = shim.navigator.plugins as object;
    const mimeTypes = shim.navigator.mimeTypes as object;
    // JS-built arrays would read `[object Array]` — a documented fabrication
    // tell. Symbol.toStringTag restores `[object PluginArray]`/`[object MimeTypeArray]`.
    expect(Object.prototype.toString.call(plugins)).toBe("[object PluginArray]");
    expect(Object.prototype.toString.call(mimeTypes)).toBe("[object MimeTypeArray]");
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

  test("5. permissions.query returns Notification.permission for notifications", async () => {
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
    const st = await patched.query({ name: "notifications" });
    // Patch 7 coerces a "denied" Notification.permission to "default" before
    // query reads it, so notifications reports the coerced value.
    expect(st.state).toBe("default");
  });

  test("6. WebGL vendor/renderer spoofed for 0x9245/0x9246 when the real GPU is a software renderer", () => {
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

  test("6b. a plausible real GPU passes through untouched (coherence — no fake override)", () => {
    const shim = buildShim();
    const proto = {
      getParameter(p: number) {
        if (p === 0x9245) return "Apple";
        if (p === 0x9246) return "Apple M-series";
        return "opaque";
      },
    };
    shim.WebGLRenderingContext = { prototype: proto };
    runInIsolation(shim);
    const glProto = (shim.WebGLRenderingContext as { prototype: { getParameter: (p: number) => string } })
      .prototype;
    // A headed device's real GPU is already coherent with the platform —
    // overriding it to Intel would create the Apple-persona + Intel-GPU
    // mismatch detection scorers exploit.
    expect(glProto.getParameter(0x9245)).toBe("Apple");
    expect(glProto.getParameter(0x9246)).toBe("Apple M-series");
    expect(glProto.getParameter(0x1f01)).toBe("opaque");
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

  test("8b. pre-seeded navigator.connection is preserved (missing-only guard)", () => {
    const shim = buildShim();
    const seeded = { effectiveType: "2g", rtt: 1000, downlink: 0.1 };
    shim.navigator.connection = seeded;
    runInIsolation(shim);
    expect(shim.navigator.connection).toBe(seeded);
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

  test("12b. pre-seeded hardwareConcurrency is preserved (missing-only guard)", () => {
    const shim = buildShim();
    shim.navigator.hardwareConcurrency = 16;
    runInIsolation(shim);
    expect(shim.navigator.hardwareConcurrency).toBe(16);
  });

  test("13. navigator.deviceMemory defaults to 8", () => {
    const shim = buildShim();
    runInIsolation(shim);
    expect(shim.navigator.deviceMemory).toBe(8);
  });

  test("13b. pre-seeded deviceMemory is preserved (missing-only guard)", () => {
    const shim = buildShim();
    shim.navigator.deviceMemory = 32;
    runInIsolation(shim);
    expect(shim.navigator.deviceMemory).toBe(32);
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

describe("anti-detection: real module execution", () => {
  test("stealthScriptBody applies the patches to the real (jsdom) environment without throwing", () => {
    const origChrome = globalThis.chrome;
    const webdriverDesc = Object.getOwnPropertyDescriptor(navigator, "webdriver");
    try {
      expect(() => stealthScriptBody()).not.toThrow();
      expect((navigator as unknown as { webdriver?: boolean }).webdriver).toBe(false);
    } finally {
      if (webdriverDesc) {
        Object.defineProperty(navigator, "webdriver", webdriverDesc);
      } else {
        delete (navigator as unknown as { webdriver?: unknown }).webdriver;
      }
      if (origChrome === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        (globalThis as { chrome?: unknown }).chrome = origChrome;
      }
    }
  });

  test("injectAntiDetection executes the stealth body in the MAIN world of every frame", async () => {
    let captured: { target: { tabId: number; allFrames: boolean }; world: string; injectImmediately: boolean; func: unknown } | undefined;
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: async (opts: typeof captured) => {
          captured = opts;
        },
      },
    });
    await injectAntiDetection(42);
    // allFrames: true patches same- and cross-origin child frames so a session
    // never claims two identities (top frame patched, worker/child frames raw).
    expect(captured?.target).toEqual({ tabId: 42, allFrames: true });
    expect(captured?.world).toBe("MAIN");
    expect(captured?.injectImmediately).toBe(true);
    expect(captured?.func).toBe(stealthScriptBody);
    vi.unstubAllGlobals();
  });

  test("blocked-page injection errors are non-fatal (debug-only log)", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: async () => {
          throw new Error("Cannot access chrome:// url");
        },
      },
    });
    await expect(injectAntiDetection(7)).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  test("unexpected injection failures surface a warning but do not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: async () => {
          throw new Error("tab closed mid-injection");
        },
      },
    });
    await expect(injectAntiDetection(7)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("anti-detection: per-profile stealth seed drift", () => {
  // Run the serialized body with a caller-supplied seed (mirrors how the SW
  // passes the profile seed via executeScript args).
  function runInIsolationWithSeed(shim: Shim, seed: unknown): void {
    const src = stealthScriptBody.toString();
    const runner = new Function(
      "navigator",
      "window",
      "screen",
      "console",
      "WebGLRenderingContext",
      "WebGL2RenderingContext",
      "Notification",
      "seed",
      "return (" + src + ")(seed);",
    ) as (n: unknown, w: unknown, s: unknown, c: unknown, g: unknown, g2: unknown, nt: unknown, sd: unknown) => void;
    runner(
      shim.navigator,
      shim.window,
      shim.screen,
      shim.console,
      shim.WebGLRenderingContext,
      shim.WebGL2RenderingContext,
      shim.Notification,
      seed,
    );
  }

  test("a caller-supplied seed drives the fabricated persona (drift)", () => {
    const shim = buildShim();
    runInIsolationWithSeed(shim, {
      hardwareConcurrency: 12,
      deviceMemory: 4,
      connectionRtt: 65,
      connectionDownlink: 20,
    });
    expect(shim.navigator.hardwareConcurrency).toBe(12);
    expect(shim.navigator.deviceMemory).toBe(4);
    const connection = shim.navigator.connection as { rtt: number; downlink: number };
    expect(connection.rtt).toBe(65);
    expect(connection.downlink).toBe(20);
  });

  test("a malformed seed falls back to the legacy defaults (no throw)", () => {
    const shim = buildShim();
    runInIsolationWithSeed(shim, { hardwareConcurrency: "many", deviceMemory: null });
    expect(shim.navigator.hardwareConcurrency).toBe(4);
    expect(shim.navigator.deviceMemory).toBe(8);
  });

  test("isValidStealthSeed accepts only plausible desktop grids", async () => {
    const { isValidStealthSeed, DEFAULT_STEALTH_SEED } = await import("../src/lib/agent/anti-detection");
    expect(isValidStealthSeed(DEFAULT_STEALTH_SEED)).toBe(true);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10, pluginCount: 2 })).toBe(true);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10, pluginCount: 3 })).toBe(true);
    expect(isValidStealthSeed(null)).toBe(false);
    expect(isValidStealthSeed({})).toBe(false);
    // Out-of-grid values (a corrupted stored seed) are rejected so a corrupted
    // profile never injects a tell-tale fabrication.
    expect(isValidStealthSeed({ hardwareConcurrency: 1, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10, pluginCount: 2 })).toBe(false);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 3, connectionRtt: 50, connectionDownlink: 10, pluginCount: 2 })).toBe(false);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 999, connectionDownlink: 10, pluginCount: 2 })).toBe(false);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 7, pluginCount: 2 })).toBe(false);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10, pluginCount: 5 })).toBe(false);
    expect(isValidStealthSeed({ hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10 })).toBe(false);
  });

  test("generateStealthSeed draws only in-grid values (deterministic with injected random)", async () => {
    const { generateStealthSeed } = await import("../src/lib/agent/anti-detection");
    // A sequence of randoms covering every index position.
    const randoms = [0, 0.5, 0.999];
    for (const r of randoms) {
      const seed = generateStealthSeed(() => r);
      expect([2, 4, 6, 8, 12, 16]).toContain(seed.hardwareConcurrency);
      expect([4, 8]).toContain(seed.deviceMemory);
      expect(seed.connectionRtt).toBeGreaterThanOrEqual(30);
      expect(seed.connectionRtt).toBeLessThanOrEqual(90);
      expect([10, 20, 30]).toContain(seed.connectionDownlink);
    }
    // Different random values must be able to produce different personas
    // (the drift is real, not a constant).
    const a = generateStealthSeed(() => 0);
    const b = generateStealthSeed(() => 0.9);
    expect(JSON.stringify(a) === JSON.stringify(b)).toBe(false);
  });

  test("resolveStealthSeed reuses a stored valid seed and persists a fresh one", async () => {
    const { resolveStealthSeed } = await import("../src/lib/agent/anti-detection");
    const store = new Map<string, unknown>();
    const chromeStub = {
      storage: {
        local: {
          get: async (keys: string) => {
            const out: Record<string, unknown> = {};
            if (store.has(keys)) out[keys] = store.get(keys);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
        },
      },
    };
    vi.stubGlobal("chrome", chromeStub);
    try {
      const first = await resolveStealthSeed();
      // Persisted under the profile key.
      expect(store.size).toBe(1);
      const second = await resolveStealthSeed();
      expect(second).toEqual(first); // stable within the profile
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("resolveStealthSeed rejects a corrupted stored seed and re-draws", async () => {
    const { resolveStealthSeed } = await import("../src/lib/agent/anti-detection");
    const store = new Map<string, unknown>([["stealth_profile_seed_v1", { hardwareConcurrency: 99, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10 }]]);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys: string) => {
            const out: Record<string, unknown> = {};
            if (store.has(keys)) out[keys] = store.get(keys);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
        },
      },
    });
    try {
      const seed = await resolveStealthSeed();
      expect([2, 4, 6, 8, 12, 16]).toContain(seed.hardwareConcurrency);
      expect(seed.hardwareConcurrency).not.toBe(99);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("resolveStealthSeed fails closed to defaults when storage is unavailable", async () => {
    const { resolveStealthSeed, DEFAULT_STEALTH_SEED } = await import("../src/lib/agent/anti-detection");
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: () => Promise.reject(new Error("storage unavailable")),
          set: () => Promise.reject(new Error("storage unavailable")),
        },
      },
    });
    try {
      await expect(resolveStealthSeed()).resolves.toEqual(DEFAULT_STEALTH_SEED);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
