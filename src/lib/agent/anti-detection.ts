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
 *   1.  navigator.webdriver          → undefined (the #1 automation tell)
 *   2.  navigator.plugins/mimeTypes  → FakePlugin array (headless leaves empty)
 *   3.  navigator.languages          → ['en-US','en'] frozen (headless leaves empty)
 *   4.  window.chrome.runtime        → stub (headless leaves undefined)
 *   5.  permissions.query            → notifications returns Notification.permission
 *   6.  WebGL vendor/renderer        → 'Intel Inc.' / 'Intel Iris OpenGL Engine'
 *   7.  Notification.permission      → 'default' (headless denies by default)
 *   8.  navigator.connection         → 4g/50rtt/10downlink stub
 *   9.  iframe contentWindow.chrome  → covered by patch 4 (same-origin propagation)
 *   10. console.*.toString()         → 'function name() { [native code] }'
 *   11. outerWidth/outerHeight + screen.colorDepth/pixelDepth (headless reports 0)
 *   12. navigator.hardwareConcurrency → 4 (if missing)
 *   13. navigator.deviceMemory        → 8 (if missing)
 *
 * The script body is inlined into the `func` parameter of
 * `chrome.scripting.executeScript` because MV3 serializes the function via
 * `Function.prototype.toString()` — closed-over variables (like a module-level
 * `STEALTH_SCRIPT` constant) would throw "X is not defined" at injection time.
 */

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
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: stealthScriptBody,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pages like chrome://, about:, edge:// and other extension pages block
    // script injection by design — expected and non-fatal.
    const isBlockedPage =
      /cannot access|can'?t access|chrome:\/\/|about:|edge:\/\/|not allowed|not permitted|forbidden/i.test(
        msg,
      );
    if (isBlockedPage) {
      console.debug("[anti-detection] injection skipped (blocked page):", msg);
    } else {
      // Unexpected failure — surface so the orchestrator/user knows stealth
      // was not applied to this tab (rather than failing silently).
      console.warn("[anti-detection] injection failed unexpectedly:", msg);
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
function stealthScriptBody(): void {
  (function () {
    // "use strict" is required here — this function is serialized and injected
    // into the page's MAIN world via chrome.scripting, where it runs as a
    // classic script (not an ES module). Strict mode is NOT implicit there.
    "use strict";
    function p(fn: () => void) {
      try {
        fn();
      } catch {
        /* swallow — one failed patch must not break the others */
      }
    }

    // ── 1. navigator.webdriver → undefined ──
    p(function () {
      Object.defineProperty(navigator, "webdriver", {
        get: function () {
          return undefined;
        },
        configurable: true,
      });
    });

    // ── 2. navigator.plugins + mimeTypes (only if empty — Chrome 92+ populates them natively) ──
    p(function () {
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

      const m1 = new (M as unknown as new (type: string, suf: string, desc: string) => {
        type: string;
        suffixes: string;
        description: string;
        enabledPlugin?: unknown;
      })("application/pdf", "pdf", "Portable Document Format");
      const m2 = new (M as unknown as new (type: string, suf: string, desc: string) => {
        type: string;
        suffixes: string;
        description: string;
        enabledPlugin?: unknown;
      })("application/x-google-chrome-pdf", "pdf", "Portable Document Format");
      const m3 = new (M as unknown as new (type: string, suf: string, desc: string) => {
        type: string;
        suffixes: string;
        description: string;
        enabledPlugin?: unknown;
      })("application/x-nacl", "", "Native Client Executable");
      const m4 = new (M as unknown as new (type: string, suf: string, desc: string) => {
        type: string;
        suffixes: string;
        description: string;
        enabledPlugin?: unknown;
      })("application/x-pnacl", "", "Portable Native Client Executable");

      const plugins = [
        new (FakePlugin as unknown as new (
          name: string,
          fn: string,
          desc: string,
          mimes: typeof m1[],
        ) => unknown)("Chrome PDF Plugin", "internal-pdf-viewer", "Portable Document Format", [m1]),
        new (FakePlugin as unknown as new (
          name: string,
          fn: string,
          desc: string,
          mimes: typeof m1[],
        ) => unknown)("Chrome PDF Viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", "", [m2]),
        new (FakePlugin as unknown as new (
          name: string,
          fn: string,
          desc: string,
          mimes: typeof m1[],
        ) => unknown)("Native Client", "internal-nacl-plugin", "", [m3, m4]),
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
      Object.defineProperty(navigator, "plugins", {
        get: function () {
          return pa;
        },
      });

      const allMimes = [m1, m2, m3, m4];
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
      Object.defineProperty(navigator, "mimeTypes", {
        get: function () {
          return ma;
        },
      });
    });

    // ── 3. navigator.languages (cached + frozen so identity check passes) ──
    p(function () {
      const nav = navigator as Navigator & { languages?: readonly string[] };
      if (!nav.languages || nav.languages.length === 0) {
        const langs = Object.freeze(["en-US", "en"]);
        Object.defineProperty(navigator, "languages", {
          get: function () {
            return langs;
          },
        });
      }
    });

    // ── 4. window.chrome.runtime stub ──
    // Only applied when the real chrome.runtime.connect is absent (headless/CDP mode).
    // The stubs are intentionally non-functional — they exist solely to pass
    // presence checks that detection scripts probe for.
    p(function () {
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
    });

    // ── 5. Permissions API consistency ──
    p(function () {
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
    });

    // ── 6. WebGL vendor / renderer ──
    // Hardcoded to Intel Iris — the most common discrete GPU on macOS. A
    // randomized-per-session approach is more sophisticated, but static
    // values are sufficient to avoid the default "Google SwiftShader"
    // headless signal that fingerprinters detect instantly.
    p(function () {
      const handler = {
        apply: function (
          target: (this: unknown, p: number) => unknown,
          thisArg: unknown,
          args: [number],
        ) {
          const param = args[0];
          if (param === 0x9245) return "Intel Inc.";
          if (param === 0x9246) return "Intel Iris OpenGL Engine";
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
    });

    // ── 7. Notification.permission ──
    p(function () {
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        Object.defineProperty(Notification, "permission", {
          get: function () {
            return "default";
          },
          configurable: true,
        });
      }
    });

    // ── 8. navigator.connection (cached so identity check passes) ──
    p(function () {
      const nav = navigator as Navigator & { connection?: unknown };
      if (nav.connection) return;
      const conn = {
        effectiveType: "4g",
        rtt: 50,
        downlink: 10,
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
    });

    // ── 9. Iframe contentWindow.chrome ──
    // Covered by patch 4 — the chrome object is now on window, propagates to
    // iframes on the same origin via the prototype chain.

    // ── 10. console method toString ──
    p(function () {
      ["log", "info", "warn", "error", "debug", "table", "trace"].forEach(function (n) {
        const c = console as unknown as Record<string, { toString?: () => string }>;
        if (c[n]) {
          c[n].toString = function () {
            return "function " + n + "() { [native code] }";
          };
        }
      });
    });

    // ── 11. Headless-mode window / screen fixes ──
    p(function () {
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
    });

    p(function () {
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
    });

    // ── 12. navigator.hardwareConcurrency ──
    p(function () {
      const nav = navigator as Navigator & { hardwareConcurrency?: number };
      if (!nav.hardwareConcurrency)
        Object.defineProperty(navigator, "hardwareConcurrency", {
          get: function () {
            return 4;
          },
        });
    });

    // ── 13. navigator.deviceMemory ──
    p(function () {
      const nav = navigator as Navigator & { deviceMemory?: number };
      if (!nav.deviceMemory)
        Object.defineProperty(navigator, "deviceMemory", {
          get: function () {
            return 8;
          },
        });
    });
  })();
}
