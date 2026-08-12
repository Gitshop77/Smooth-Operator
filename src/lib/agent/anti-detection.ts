/**
 * Anti-detection / stealth scripts — injected via chrome.scripting into the
 * page's MAIN world as early as possible.
 *
 * NOTE: `injectImmediately: true` only guarantees earliest injection for
 * *newly created / navigated* documents. For an already-loaded tab the script
 * necessarily runs after the page's own bootstrap scripts have executed, so
 * stealth is best-effort on existing tabs: a page that reads
 * `navigator.webdriver` during its own load may already have captured the
 * automation signal. For the strongest guarantee call `injectAntiDetection`
 * immediately on tab creation or at navigation start — not after `load`.
 *
 * Without these, sites like GitHub, Google, and Cloudflare-protected sites
 * detect `navigator.webdriver === true` (and a dozen other automation
 * signals) and block, throttle, or behave differently.
 *
 * 13 patches are applied (each wrapped in try/catch so a single failure
 * never breaks the rest):
 * 1. navigator.webdriver → false (the #1 automation tell)
 * 2. navigator.plugins/mimeTypes → FakePlugin array (headless leaves empty)
 * 3. navigator.languages → ['en-US','en'] frozen (headless leaves empty)
 * 4. window.chrome.runtime → stub (headless leaves undefined)
 * 5. permissions.query → notifications returns Notification.permission
 * 6. WebGL vendor/renderer → 'Intel Inc.' / 'Intel Iris OpenGL Engine'
 * 7. Notification.permission → 'default' (headless denies by default)
 * 8. navigator.connection → 4g/50rtt/10downlink stub
 * 9. iframe contentWindow.chrome → covered by patch 4 (same-origin propagation)
 * 10. console.*.toString() → 'function name() { [native code] }'
 * 11. outerWidth/outerHeight + screen.colorDepth/pixelDepth (headless reports 0)
 * 12. navigator.hardwareConcurrency → 4 (if missing)
 * 13. navigator.deviceMemory → 8 (if missing)
 *
 * The script body is inlined into the `func` parameter of
 * `chrome.scripting.executeScript` because MV3 serializes the function via
 * `Function.prototype.toString()` — closed-over variables (like a module-level
 * `STEALTH_SCRIPT` constant) would throw "X is not defined" at injection time.
 */

import {
  BLOCKED_PAGE_RE,
  isStealthEnabled,
} from "./anti-detection-utils";

export { isStealthEnabled };

/**
 * Per-profile stealth parameter set (profile drift).
 *
 * Fixed fabrication values (hardwareConcurrency: 4, deviceMemory: 8, rtt: 50,
 * downlink: 10 on EVERY install) create a single uniform automation
 * fingerprint across every Open Cowork user — trivially correlated by an
 * anti-bot vendor. Instead the profile resolves ONE random-but-plausible
 * parameter set and reuses it for every injection of this browser profile
 * (a real device does not change its core count between navigations, so the
 * drift must be persistent, not per-page). Values stay on the grids real
 * desktop Chrome reports.
 */
export interface StealthSeed {
  hardwareConcurrency: number;
  deviceMemory: number;
  connectionRtt: number;
  connectionDownlink: number;
  /** Number of fabricated navigator.plugins entries (2 or 3). */
  pluginCount: number;
}

export const DEFAULT_STEALTH_SEED: StealthSeed = {
  hardwareConcurrency: 4,
  deviceMemory: 8,
  connectionRtt: 50,
  connectionDownlink: 10,
  pluginCount: 2,
};

/** Validates a candidate seed against the plausible-desktop grids. */
export function isValidStealthSeed(value: unknown): value is StealthSeed {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Partial<StealthSeed>;
  return (
    typeof s.hardwareConcurrency === "number" &&
    [2, 4, 6, 8, 12, 16].includes(s.hardwareConcurrency) &&
    typeof s.deviceMemory === "number" &&
    [2, 4, 8].includes(s.deviceMemory) &&
    typeof s.connectionRtt === "number" &&
    s.connectionRtt >= 30 &&
    s.connectionRtt <= 90 &&
    typeof s.connectionDownlink === "number" &&
    [5, 10, 20, 30].includes(s.connectionDownlink) &&
    typeof s.pluginCount === "number" &&
    [2, 3].includes(s.pluginCount)
  );
}

/** Draw one plausible seed. `random` is injectable for deterministic tests. */
export function generateStealthSeed(random: () => number = Math.random): StealthSeed {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length) % arr.length];
  return {
    hardwareConcurrency: pick([2, 4, 6, 8, 12, 16] as const),
    deviceMemory: pick([4, 8] as const),
    connectionRtt: pick([40, 45, 50, 55, 60, 65] as const),
    connectionDownlink: pick([10, 20, 30] as const),
    // Modern Chrome ships two PDF plugins; the legacy Native Client plugin is
    // absent on newer versions. Weight the draw toward 2 to match the
    // population while still producing both personas.
    pluginCount: pick([2, 2, 3] as const),
  };
}

const STEALTH_SEED_KEY = "stealth_profile_seed_v1";

/**
 * Resolve the profile's persistent stealth seed: reuse a stored valid seed,
 * otherwise generate + persist one (so every injection of this browser
 * profile reports ONE coherent device persona). Fails closed to the
 * legacy defaults when storage is unavailable.
 */
export async function resolveStealthSeed(): Promise<StealthSeed> {
  try {
    const res = await chrome.storage.local.get(STEALTH_SEED_KEY);
    const stored = res[STEALTH_SEED_KEY];
    if (isValidStealthSeed(stored)) return stored;
    const fresh = generateStealthSeed();
    await chrome.storage.local.set({ [STEALTH_SEED_KEY]: fresh });
    return fresh;
  } catch {
    return { ...DEFAULT_STEALTH_SEED };
  }
}

/**
 * Inject the 13 anti-detection patches into a tab.
 *
 * Best called on tab creation / at navigation start. For an already-loaded
 * tab the patches still run (in the MAIN world, isolated from the
 * content-script world) but may arrive after the page's own bootstrap, so
 * timing is best-effort — see the module-level note above.
 *
 * Injection failures are non-fatal. Some pages (chrome://, about:, edge://,
 * other extension pages) block script injection by design; those are logged
 * at debug level. Any *unexpected* failure (tab closed mid-navigation,
 * missing permission, etc.) is logged at warning level so the orchestrator
 * or user can see that stealth was NOT applied to this tab.
 *
 * @param tabId The tab to inject into.
 */
export async function injectAntiDetection(tabId: number): Promise<void> {
  try {
    const seed = await resolveStealthSeed();
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      injectImmediately: true,
      func: stealthScriptBody,
      args: [seed],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
 // Pages like chrome://, about:, edge:// and other extension pages block
 // script injection by design — expected and non-fatal.
    const isBlockedPage = BLOCKED_PAGE_RE.test(msg);
    if (isBlockedPage) {
      console.debug("[anti-detection] injection skipped (blocked page)");
    } else {
  // Unexpected failure — surface so the orchestrator/user knows stealth
  // was not applied to this tab (rather than failing silently). Log only
  // the error category, not the full message, to avoid leaking tab URLs
  // or page metadata into the extension console log.
      console.warn("[anti-detection] injection failed unexpectedly");
    }
  }
}

/**
 * The stealth-script body, declared as a named function so it can be passed
 * to `chrome.scripting.executeScript({func})`. The function is serialized
 * via `Function.prototype.toString()`, so it must not reference any
 * closed-over variables — everything it needs is in its own scope.
 *
 * Runs as an IIFE inside the page's MAIN world. Each patch is wrapped in
 * try/catch via the `p()` helper so a single failure never breaks the rest.
 */
export function stealthScriptBody(seed?: StealthSeed): void {
  (function () {
    "use strict";
    // Inline seed resolution: this body is serialized via toString and runs in
    // the page's MAIN world, so it must not reference module-level constants.
    // The SW passes the profile's persistent seed via executeScript args.
    const s: StealthSeed =
      seed && typeof seed.hardwareConcurrency === "number" && typeof seed.deviceMemory === "number"
        ? seed
        : { hardwareConcurrency: 4, deviceMemory: 8, connectionRtt: 50, connectionDownlink: 10, pluginCount: 2 };
    function p(fn: () => void) {
      try {
        fn();
      } catch {
        /* swallow — one failed patch must not break the others */
      }
    }

    function patchWebdriver() {
      // Real Chrome exposes `navigator.webdriver` ONLY as a prototype getter
      // with NO own property on the instance. Restore that exact shape:
      // delete any own property first (an own data property is itself a tell),
      // then define the getter on `Navigator.prototype` — and mirror it on
      // `WorkerNavigator.prototype` so worker-vs-main coherence probes see the
      // same surface. The getter returns `false` (falsy like the native
      // `undefined`) and keeps the value-probe answer identical to the old
      // patch while fixing descriptor/own-property-based probes.
      //
      // Fallback: when the instance does NOT inherit from `Navigator.prototype`
      // (plain-object shims / exotic embeddings — never real Chrome), define
      // the getter on the instance too so value probes still read `false`.
      try {
        delete (navigator as unknown as Record<string, unknown>).webdriver;
      } catch {
        /* own property may be non-configurable on a hostile page — leave it */
      }
      const getter = function (this: unknown): boolean {
        return false;
      };
      const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
      const inherits = navProto ? Object.getPrototypeOf(navigator) === navProto : false;
      if (navProto) {
        Object.defineProperty(navProto, "webdriver", {
          get: getter,
          configurable: true,
        });
      }
      const workerNavCtor = (globalThis as unknown as { WorkerNavigator?: { prototype?: object } })
        .WorkerNavigator;
      if (workerNavCtor?.prototype) {
        Object.defineProperty(workerNavCtor.prototype, "webdriver", {
          get: getter,
          configurable: true,
        });
      }
      if (!inherits) {
        Object.defineProperty(navigator, "webdriver", {
          get: getter,
          configurable: true,
        });
      }
    }

    function patchPlugins() {
      const nav = navigator as Navigator & { plugins: PluginArray; mimeTypes: MimeTypeArray };
      if (nav.plugins && nav.plugins.length > 0) return;

      function FakePlugin(
        this: unknown,
        name: string,
        fn: string,
        desc: string,
        mimes: Array<{ type: string; suffixes: string; description: string; enabledPlugin?: unknown }>,
      ) {
        (this as { name: string }).name = name;
        (this as { filename: string }).filename = fn;
        (this as { description: string }).description = desc;
        (this as { length: number }).length = mimes.length;
        for (let i = 0; i < mimes.length; i++) {
          (this as Record<number, unknown>)[i] = mimes[i];
          mimes[i].enabledPlugin = this;
        }
      }
      FakePlugin.prototype.item = function (i: number) {
        return (this as Record<number, unknown>)[i] || null;
      };
      FakePlugin.prototype.namedItem = function (n: string) {
        const len = (this as { length: number }).length;
        for (let i = 0; i < len; i++) {
          const item = (this as Record<number, { type: string }>)[i];
          if (item && item.type === n) return item;
        }
        return null;
      };

      function M(this: unknown, type: string, suf: string, desc: string) {
        (this as { type: string }).type = type;
        (this as { suffixes: string }).suffixes = suf;
        (this as { description: string }).description = desc;
      }

      type MimeShape = {
        type: string;
        suffixes: string;
        description: string;
        enabledPlugin?: unknown;
      };
      const MimeCtor = M as unknown as new (t: string, s: string, d: string) => MimeShape;
      const [m1, m2, m3, m4] = [
        ["application/pdf", "pdf", "Portable Document Format"],
        ["application/x-google-chrome-pdf", "pdf", "Portable Document Format"],
        ["application/x-nacl", "", "Native Client Executable"],
        ["application/x-pnacl", "", "Portable Native Client Executable"],
      ].map(([t, s, d]) => new MimeCtor(t, s, d));

      const PluginCtor = FakePlugin as unknown as new (
        name: string,
        fn: string,
        desc: string,
        mimes: MimeShape[],
      ) => unknown;
      const plugins = [
        new PluginCtor("Chrome PDF Plugin", "internal-pdf-viewer", "Portable Document Format", [m1]),
        new PluginCtor("Chrome PDF Viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", "", [m2]),
        ...(s.pluginCount === 3
          ? [new PluginCtor("Native Client", "internal-nacl-plugin", "", [m3, m4])]
          : []),
      ];

      function makeIterable(
        arr: { length: number; [k: number]: unknown; [Symbol.iterator]?: () => unknown },
        items: unknown[],
      ) {
        arr.length = items.length;
        for (let i = 0; i < items.length; i++) arr[i] = items[i];
        arr[Symbol.iterator] = function () {
          let idx = 0;
          return {
            next: function () {
              return idx < items.length
                ? { value: items[idx++], done: false }
                : { value: undefined, done: true };
            },
          };
        };
      }

      const pa: {
        length: number;
        [k: number]: unknown;
        [Symbol.iterator]?: () => unknown;
        item: (i: number) => unknown;
        namedItem: (n: string) => unknown;
        refresh: () => void;
      } = {
        length: 0,
        item: function (i) {
          return plugins[i] || null;
        },
        namedItem: function (n) {
          for (let i = 0; i < plugins.length; i++) {
            const pl = plugins[i] as { name: string };
            if (pl.name === n) return plugins[i];
          }
          return null;
        },
        refresh: function () {},
      };
      makeIterable(pa, plugins);
      // JS-built arrays stringify to `[object Array]` — a documented plugin-
      // fabrication tell. `Symbol.toStringTag` restores the native
      // stringification so `String(navigator.plugins)` reads `[object
      // PluginArray]`. (The native PluginArray is populated → no-op path above
      // keeps zero touch when a real plugin set already exists.)
      try {
        Object.defineProperty(pa, Symbol.toStringTag, { value: "PluginArray" });
      } catch {
        /* ignore — a hostile/frozen object must not break the patch */
      }
      Object.defineProperty(navigator, "plugins", {
        get: function () {
          return pa;
        },
      });

      const allMimes = s.pluginCount === 3 ? [m1, m2, m3, m4] : [m1, m2];
      const ma: {
        length: number;
        [k: number]: unknown;
        [Symbol.iterator]?: () => unknown;
        item: (i: number) => unknown;
        namedItem: (n: string) => unknown;
      } = {
        length: 0,
        item: function (i) {
          return allMimes[i] || null;
        },
        namedItem: function (n) {
          for (let i = 0; i < allMimes.length; i++) {
            if (allMimes[i].type === n) return allMimes[i];
          }
          return null;
        },
      };
      makeIterable(ma, allMimes);
      try {
        Object.defineProperty(ma, Symbol.toStringTag, { value: "MimeTypeArray" });
      } catch {
        /* ignore */
      }
      Object.defineProperty(navigator, "mimeTypes", {
        get: function () {
          return ma;
        },
      });
    }

    function patchLanguages() {
      const nav = navigator as Navigator & { languages?: readonly string[]; language?: string };
      if (!nav.languages || nav.languages.length === 0) {
        const langs = Object.freeze(["en-US", "en"]);
        Object.defineProperty(navigator, "languages", {
          get: function () {
            return langs;
          },
        });
        Object.defineProperty(navigator, "language", {
          get: function () {
            return "en-US";
          },
          configurable: true,
        });
      }
    }

    function patchChromeRuntime() {
      const w = window as unknown as {
        chrome?: {
          runtime?: { connect?: unknown; onMessage?: unknown; onConnect?: unknown; sendMessage?: unknown; id?: unknown };
          loadTimes?: unknown;
          csi?: unknown;
          app?: unknown;
        };
      };
      if (w.chrome && w.chrome.runtime && w.chrome.runtime.connect) return;

      const chrome = w.chrome || {};
      const noop = function () {};
      const evtStub = {
        addListener: noop,
        removeListener: noop,
        hasListeners: function () {
          return false;
        },
      };
      chrome.runtime = chrome.runtime || {};
      chrome.runtime.onMessage = chrome.runtime.onMessage || evtStub;
      chrome.runtime.onConnect = chrome.runtime.onConnect || evtStub;
      chrome.runtime.sendMessage = chrome.runtime.sendMessage || noop;
      chrome.runtime.connect = chrome.runtime.connect || function () {
        return { onMessage: { addListener: noop }, postMessage: noop, disconnect: noop };
      };
      if (!chrome.loadTimes)
        chrome.loadTimes = function () {
          return {};
        };
      if (!chrome.csi)
        chrome.csi = function () {
          return {};
        };
      if (!chrome.app) {
        chrome.app = {
          isInstalled: false,
          InstallState: {
            INSTALLED: "installed",
            NOT_INSTALLED: "not_installed",
            DISABLED: "disabled",
          },
          RunningState: {
            CANNOT_RUN: "cannot_run",
            READY_TO_RUN: "ready_to_run",
            RUNNING: "running",
          },
          getDetails: function () {
            return null;
          },
          getIsInstalled: function () {
            return false;
          },
          runningState: function () {
            return "cannot_run";
          },
        };
      }

      if (!w.chrome) {
        Object.defineProperty(window, "chrome", {
          value: chrome,
          writable: false,
          enumerable: true,
          configurable: false,
        });
      }
    }

    function patchPermissions() {
      const nav = navigator as Navigator & {
        permissions: Permissions & { query: (p: { name: string }) => Promise<PermissionStatus> };
      };
      if (!nav.permissions || !nav.permissions.query) return;
      const orig = nav.permissions.query.bind(nav.permissions);
      function q(this: unknown, params: { name: string }) {
        if (params.name === "notifications") {
          return Promise.resolve({
            state:
              typeof Notification !== "undefined" ? Notification.permission : "prompt",
            name: "notifications",
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () {
              return true;
            },
          } as unknown as PermissionStatus);
        }
        return orig(params);
      }
      q.toString = function () {
        return "function query() { [native code] }";
      };
      nav.permissions.query = q as typeof nav.permissions.query;
    }

    function patchWebGL() {
      // Coherence rule: only fabricate a vendor/renderer when the real GPU is
      // missing or a known software renderer. A headed Chrome on real hardware
      // already reports a plausible GPU (e.g. "Apple" / "Apple M-series"),
      // and overriding it to Intel on macOS creates exactly the cross-attribute
      // mismatch (Apple persona + Intel GPU) that detection scorers exploit.
      const BAD_RENDERER_RE = /swiftshader|llvmpipe|software|basic render/i;
      const handler = {
        apply: function (
          target: (this: unknown, p: number) => unknown,
          thisArg: unknown,
          args: [number],
        ) {
          const param = args[0];
          if (param === 0x9245 || param === 0x9246) {
            const real = Reflect.apply(target, thisArg, args);
            if (real && !BAD_RENDERER_RE.test(String(real))) return real;
            // Fabricate a coherent Intel/Apple-neutral persona for the
            // software/empty case (headless Chrome reports SwiftShader).
            return param === 0x9245 ? "Intel Inc." : "Intel Iris OpenGL Engine";
          }
          return Reflect.apply(target, thisArg, args);
        },
      };
      if (typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext.prototype) {
        WebGLRenderingContext.prototype.getParameter = new Proxy(
          WebGLRenderingContext.prototype.getParameter,
          handler,
        ) as typeof WebGLRenderingContext.prototype.getParameter;
      }
      if (typeof WebGL2RenderingContext !== "undefined" && WebGL2RenderingContext.prototype) {
        WebGL2RenderingContext.prototype.getParameter = new Proxy(
          WebGL2RenderingContext.prototype.getParameter,
          handler,
        ) as typeof WebGL2RenderingContext.prototype.getParameter;
      }
    }

    function patchNotification() {
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        Object.defineProperty(Notification, "permission", {
          get: function () {
            return "default";
          },
          configurable: true,
        });
      }
    }

    function patchConnection() {
      const nav = navigator as Navigator & { connection?: unknown };
      if (nav.connection) return;
      const conn = {
        effectiveType: "4g",
        rtt: s.connectionRtt,
        downlink: s.connectionDownlink,
        saveData: false,
        onchange: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () {
          return true;
        },
      };
      Object.defineProperty(navigator, "connection", {
        get: function () {
          return conn;
        },
      });
    }

    function patchConsole() {
      ["log", "info", "warn", "error", "debug", "table", "trace"].forEach(function (n) {
        const c = console as unknown as Record<string, { toString?: () => string }>;
        if (c[n]) {
          c[n].toString = function () {
            return "function " + n + "() { [native code] }";
          };
        }
      });
    }

    function patchWindowScreen() {
      if (window.outerWidth === 0)
        Object.defineProperty(window, "outerWidth", {
          get: function () {
            return window.innerWidth || 1920;
          },
        });
      if (window.outerHeight === 0)
        Object.defineProperty(window, "outerHeight", {
          get: function () {
            return (window.innerHeight || 1080) + 85;
          },
        });
    }

    function patchColorDepth() {
      if (screen.colorDepth === 0) {
        Object.defineProperty(screen, "colorDepth", {
          get: function () {
            return 24;
          },
        });
        Object.defineProperty(screen, "pixelDepth", {
          get: function () {
            return 24;
          },
        });
      }
    }

    function patchHardwareConcurrency() {
      const nav = navigator as Navigator & { hardwareConcurrency?: number };
      if (!nav.hardwareConcurrency) {
        // Fabricated only when missing. Real hardwareConcurrency values sit on
        // the physical-core grid (2/4/6/8/12/16…); pick from that grid so a
        // headless value reads like a genuine device rather than a bare 1/0.
        // The profile's persistent seed (resolved by the SW once per browser
        // profile) — a stable, plausible core count that varies across
        // installs instead of a single uniform fabrication value.
        Object.defineProperty(navigator, "hardwareConcurrency", {
          get: function () {
            return s.hardwareConcurrency;
          },
        });
      }
    }

    function patchDeviceMemory() {
      const nav = navigator as Navigator & { deviceMemory?: number };
      if (!nav.deviceMemory) {
        // Fabricated only when missing. deviceMemory is a power-of-two grid
        // (0.25/0.5/1/2/4/8) and never above 8 — the profile seed picks from it.
        Object.defineProperty(navigator, "deviceMemory", {
          get: function () {
            return s.deviceMemory;
          },
        });
      }
    }

    p(patchWebdriver);
    p(patchPlugins);
    p(patchLanguages);
    p(patchChromeRuntime);
    p(patchPermissions);
    p(patchWebGL);
    p(patchNotification);
    p(patchConnection);
    p(patchConsole);
    p(patchWindowScreen);
    p(patchColorDepth);
    p(patchHardwareConcurrency);
    p(patchDeviceMemory);
  })();
}
