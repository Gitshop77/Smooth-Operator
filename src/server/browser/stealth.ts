/**
 * Stealth: launch-arg builder + coherent init-script source.
 *
 * Pure module — produces strings only. No browser runtime is imported and there
 * are no side effects at import time. `buildStealthLaunchArgs` returns the args
 * to APPEND when stealth is enabled; `buildStealthInitScript` returns a single
 * bundled page-JS source string that is injected once per document via
 * `page.evaluateOnNewDocument`. Both interpolate the coherent fingerprint
 * profile so the in-page patches match the launch fingerprint (no drift).
 *
 * Coherence over maximality: every patch is guarded and never throws (a throwing
 * patch is a louder tell). On new-headless many leaks auto-resolve, so the
 * `balanced` profile stays minimal and `max` adds guarded, coherence-gated
 * extras.
 */

import type { FingerprintProfile } from "./fingerprints";

/**
 * Phase 1 baseline flags (append-only, never mutated by callers). A separate
 * builder so the default-args test still sees a clean native set.
 */
export const STEALTH_BASELINE_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled", // hide navigator.webdriver at the C++ source
  "--lang=en-US", // navigator.language / Intl coherence
  "--window-size=1920,1080", // consistent viewport / screen
];

// Real-GPU rendering so WebGL/canvas pixels are coherent with the claimed
// renderer. Added only when `gpu` is requested.
const GPU_ARGS: readonly string[] = ["--use-angle=vulkan", "--enable-vulkan"];

/**
 * Build the launch args to APPEND to the native args when stealth is enabled.
 * Language/viewport are interpolated from the profile so `--lang` / `--window-size`
 * stay coherent with the in-page UA/languages. A fresh array is returned (the
 * shared baseline is never mutated) and the set is internally deduped.
 */
export function buildStealthLaunchArgs(
  profile: FingerprintProfile,
  gpu: boolean,
): readonly string[] {
  const args: string[] = [
    "--disable-blink-features=AutomationControlled",
    `--lang=${profile.languages[0]}`,
    `--window-size=${profile.viewport.width},${profile.viewport.height}`,
  ];
  if (gpu) {
    args.push(...GPU_ARGS);
  }
  return args;
}

/**
 * Build the bundled init-script SOURCE (a single string, injected once per
 * document via `page.evaluateOnNewDocument(source)`). The source is self-
 * contained page-JS that runs in the page main world before page scripts and
 * interpolates the profile values so the patches match the launch fingerprint.
 */
export function buildStealthInitScript(
  profile: FingerprintProfile,
  options: { max?: boolean } = {},
): string {
  const languages = JSON.stringify(profile.languages);
  const brands = JSON.stringify(profile.brands);
  const fullVersionList = JSON.stringify(profile.fullVersionList);
  const { width, height } = profile.viewport;
  const hardwareConcurrency = JSON.stringify(profile.hardwareConcurrency ?? null);
  const deviceMemory = JSON.stringify(profile.deviceMemory ?? null);
  const maxTouchPoints = JSON.stringify(profile.maxTouchPoints ?? null);
  const timeZone = JSON.stringify(profile.timeZone ?? null);
  const useMax = options.max === true;

  const head = `
  // ---- shared helpers (ported, minimal) ----
  function makeNativeString(fnName) {
    return 'function ' + fnName + '() { [native code] }';
  }
  function patchToString(target, fnStr) {
    try {
      Object.defineProperty(target, 'toString', {
        configurable: true,
        writable: true,
        value: function toString() { return fnStr; }
      });
    } catch (e) {}
  }
  function stripProxyFromErrors(fn) {
    try {
      return new Proxy(fn, {
        apply: function applyTrap(target, thisArg, args) {
          try { return Reflect.apply(target, thisArg, args); }
          catch (e) { throw e; }
        }
      });
    } catch (e) { return fn; }
  }

  // ---- coherent fingerprint (interpolated from the launch profile) ----
  var LANGUAGES = ${languages};
  var BRANDS = ${brands};
  var FULL_VERSION_LIST = ${fullVersionList};
  var VIEWPORT = { width: ${width}, height: ${height} };
  var HW_CONCURRENCY = ${hardwareConcurrency};
  var DEVICE_MEMORY = ${deviceMemory};
  var MAX_TOUCH_POINTS = ${maxTouchPoints};
  var TIME_ZONE = ${timeZone};`;

  const balanced = `
  // 1. navigator.webdriver — belt-and-suspenders (the launch flag is primary).
  try {
    var navProto = Object.getPrototypeOf(navigator);
    if (navProto && Object.prototype.hasOwnProperty.call(navProto, 'webdriver')) {
      delete navProto.webdriver;
    }
  } catch (e) {}

  // 2. navigator.languages — match Accept-Language / geo.
  try {
    Object.defineProperty(navigator, 'languages', {
      value: LANGUAGES, configurable: true, enumerable: true
    });
  } catch (e) {}

  // 3. navigator.vendor — consistency with the UA.
  try {
    Object.defineProperty(navigator, 'vendor', {
      value: 'Google Inc.', configurable: true, enumerable: true
    });
  } catch (e) {}

  // 4. navigator.userAgentData — strip HeadlessChrome brand, coherent fullVersionList.
  try {
    if (navigator.userAgentData) {
      if (Array.isArray(navigator.userAgentData.brands)) {
        var cleaned = navigator.userAgentData.brands.filter(function (item) {
          return item && typeof item.brand === 'string' && item.brand.indexOf('Headless') === -1;
        });
        if (cleaned.length === 0) { cleaned = BRANDS.slice(); }
        try {
          Object.defineProperty(navigator.userAgentData, 'brands', {
            value: cleaned, configurable: true, enumerable: true
          });
        } catch (e) {}
      }
      if (navigator.userAgentData.fullVersionList) {
        try {
          Object.defineProperty(navigator.userAgentData, 'fullVersionList', {
            value: FULL_VERSION_LIST, configurable: true, enumerable: true
          });
        } catch (e) {}
      }
    }
  } catch (e) {}

  // 5. window.chrome — fabricate app/csi/loadTimes/runtime (secure-origin guard).
  try {
    var runtime = {
      id: undefined,
      onConnect: { addListener: function () {}, removeListener: function () {} },
      onMessage: { addListener: function () {}, removeListener: function () {} },
      sendRequest: function () {},
      connect: function () { return { onMessage: {}, onDisconnect: {} }; }
    };
    var chromeObj = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      csi: function csi() {},
      loadTimes: function loadTimes() {},
      runtime: runtime
    };
    if (window.location && window.location.protocol !== 'https:') {
      chromeObj.runtime = undefined;
    }
    if (!window.chrome || !window.chrome.runtime) {
      Object.defineProperty(window, 'chrome', {
        value: chromeObj, enumerable: true, configurable: true, writable: true
      });
    }
  } catch (e) {}

  // 6. navigator.permissions.query — resolve the "impossible combination".
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var perms = navigator.permissions;
      var originalQuery = perms.query.bind(perms);
      perms.query = function (query) {
        if (query && query.name === 'notifications' &&
            window.location && window.location.protocol !== 'https:') {
          try {
            if (typeof PermissionStatus !== 'undefined') {
              return Promise.resolve(new PermissionStatus({ state: 'denied' }));
            }
          } catch (e) {}
        }
        return originalQuery(query);
      };
    }
  } catch (e) {}

  // 7. toString / Proxy trace hiding — the patched getters hide themselves.
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var hiddenQuery = stripProxyFromErrors(navigator.permissions.query);
      patchToString(hiddenQuery, makeNativeString('query'));
      navigator.permissions.query = hiddenQuery;
    }
  } catch (e) {}

  // Coherence: screen dimensions track the launch viewport (guarded, best-effort).
  try {
    if (window && typeof window.innerWidth === 'number') {
      Object.defineProperty(window, 'innerWidth', {
        value: VIEWPORT.width, configurable: true, enumerable: false
      });
      Object.defineProperty(window, 'innerHeight', {
        value: VIEWPORT.height, configurable: true, enumerable: false
      });
    }
  } catch (e) {}`;

  const maxPatches = `
  // ---- max profile: additional coherent patches (guarded, never throw) ----

  // 8. navigator.plugins / navigator.mimeTypes — rebuild only when empty.
  try {
    if (navigator.plugins && navigator.plugins.length === 0 &&
        navigator.mimeTypes && navigator.mimeTypes.length === 0) {
      var pdf = {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
        enabledPlugin: null
      };
      var plugin = {
        name: 'Portable Document Format',
        filename: 'libpdf.plugin',
        description: 'Portable Document Format',
        length: 1,
        mimeTypes: [pdf]
      };
      pdf.enabledPlugin = plugin;
      try {
        Object.defineProperty(navigator, 'mimeTypes', {
          value: [pdf], configurable: true, enumerable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'plugins', {
          value: [plugin], configurable: true, enumerable: true
        });
      } catch (e) {}
    }
  } catch (e) {}

  // 9. hardwareConcurrency / deviceMemory / maxTouchPoints — realistic desktop.
  try {
    if (HW_CONCURRENCY !== null) {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        value: HW_CONCURRENCY, configurable: true, enumerable: true
      });
    }
  } catch (e) {}
  try {
    if (DEVICE_MEMORY !== null) {
      Object.defineProperty(navigator, 'deviceMemory', {
        value: DEVICE_MEMORY, configurable: true, enumerable: true
      });
    }
  } catch (e) {}
  try {
    if (MAX_TOUCH_POINTS !== null) {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: MAX_TOUCH_POINTS, configurable: true, enumerable: true
      });
    }
  } catch (e) {}

  // 10. media.codecs — canPlayType / MediaSource.isTypeSupported.
  try {
    if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.canPlayType) {
      var originalCanPlayType = HTMLMediaElement.canPlayType.bind(HTMLMediaElement);
      HTMLMediaElement.canPlayType = function (type) {
        if (typeof type === 'string') {
          var known = [
            'video/mp4; codecs="avc1.42E01E"',
            'video/webm; codecs="vp8"',
            'audio/webm',
            'audio/ogg; codecs="vorbis"'
          ];
          if (known.indexOf(type) !== -1) { return 'probably'; }
        }
        try { return originalCanPlayType(type); } catch (e) { return ''; }
      };
    }
  } catch (e) {}

  // 11. Intl timezone coherence.
  try {
    if (typeof Intl !== 'undefined' && TIME_ZONE !== null &&
        Intl.DateTimeFormat && Intl.DateTimeFormat.prototype) {
      var originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      if (typeof originalResolved === 'function') {
        Intl.DateTimeFormat.prototype.resolvedOptions = function () {
          var opts = originalResolved.call(this);
          opts.timeZone = TIME_ZONE;
          return opts;
        };
      }
    }
  } catch (e) {}

  // 12. webgl vendor/renderer (guarded; skip when unavailable).
  try {
    if (typeof WebGLRenderingContext !== 'undefined') {
      var glHandler = {
        apply: function (target, thisArg, args) {
          if (args[0] === 37445) { return 'Intel Inc.'; }
          if (args[0] === 37446) { return 'Intel(R) Iris(TM) Plus Graphics 655'; }
          return Reflect.apply(target, thisArg, args);
        }
      };
      Object.defineProperty(WebGLRenderingContext.prototype, 'getParameter', {
        value: new Proxy(WebGLRenderingContext.prototype.getParameter, glHandler),
        configurable: true, enumerable: false, writable: true
      });
    }
  } catch (e) {}

  // 13. iframe.contentWindow — srcdoc frame isolation (guarded).
  try {
    if (typeof HTMLIFrameElement !== 'undefined' && HTMLIFrameElement.prototype) {
      var iframeDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (iframeDesc && iframeDesc.get) {
        var originalContentWindowGet = iframeDesc.get;
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          configurable: true, enumerable: false,
          get: function () {
            var win = originalContentWindowGet.call(this);
            try {
              if (win && win.Navigator) {
                Object.defineProperty(win.Navigator.prototype, 'webdriver', {
                  get: function () { return undefined; },
                  configurable: true, enumerable: true
                });
              }
            } catch (e) {}
            return win;
          }
        });
      }
    }
  } catch (e) {}`;

  return `(function () {\n${head}\n${balanced}${useMax ? maxPatches : ""}\n})();\n`;
}
