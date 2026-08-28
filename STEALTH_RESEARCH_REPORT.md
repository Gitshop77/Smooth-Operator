# Stealth Libraries for Puppeteer/Playwright Headless Automation — Technical Report

**Purpose:** Survey of state-of-the-art stealth techniques for Puppeteer-core ^25 + full Chromium, for legitimate automated-testing quality and task-success improvement.

**Date:** August 2026. Scope note: everything here is fingerprint/handler hardening for automation under your own control; it does not solve CAPTCHAs and does not override IP-reputation or rate limits.

---

## TL;DR

- The classic JS-layer plugins (`puppeteer-extra-plugin-stealth`, `playwright-stealth`) still defeat **naive** detectors and cover ~16 named `navigator`/`chrome` tells, but they are **unmaintained since mid-2024** and cannot touch anything below the JavaScript runtime.
- The single most reliable 2024–2026 tell is the **CDP `Runtime.enable` leak** (how the driver talks to Chrome), plus **TLS/JA4 + datacenter-IP + behavioral** mismatch. No in-page patch fixes these.
- The modern recipe is: **full Chrome (not headless-shell) + `--disable-blink-features=AutomationControlled` + a `Page.addScriptToEvaluateOnNewDocument` bundle + a coherent fingerprint (UA/client-hints/viewport/lang/DPR/touch as one set) + a human-like behavior layer**, and — if you must run Puppeteer/Playwright under CDP — patch the driver itself (`rebrowser-patches`) or switch to a direct-CDP driver (`nodriver`).

---

## 1. puppeteer-extra + puppeteer-extra-plugin-stealth

### 1.1 How it works — the PuppeteerEnhancer AOP-style plugin system

`puppeteer-extra` is a drop-in replacement for `puppeteer`. Its core is a **`PuppeteerEnhancer`** — an aspect-oriented hook layer that intercepts the browser/page lifecycle. A plugin extends `PuppeteerExtraPlugin` and registers **lifecycle hooks**:

| Hook | Fires when | Typical use in stealth |
|---|---|---|
| `beforeLaunch(options)` | Before `puppeteer.launch()` | Inject launch args like `--disable-blink-features=AutomationControlled` |
| `onBrowser(browser)` | After a browser connects | Attach CDP listeners |
| `onPageCreated(page)` | Every `newPage()`/new tab | Register `page.evaluateOnNewDocument(...)` |
| `onClose` / `onError` | Cleanup | Release locks |

The plugin system is dependency-injected: `puppeteer.use(plugin)` and the enhancer calls hooks in registration order. This is what lets `playwright-extra` reuse the exact same stealth modules for Playwright (`chromium.use(StealthPlugin())`).

```js
const puppeteer = require('puppeteer-extra')          // enhancer wrapper
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())                          // registers hooks
puppeteer.launch({ headless: true }).then(browser => { /* ... */ })
```

### 1.2 The exact stealth patches (the evasions)

The `stealth` plugin is a bundle of ~16 standalone evasion modules. The full `availableEvasions` set (from the source README and confirmed by Foil's 2026 deconstruction):

1. **`chrome.app`** — fabricate `window.chrome.app` (absent in headless)
2. **`chrome.csi`** — fabricate the Chrome System Information API
3. **`chrome.loadTimes`** — fabricate the deprecated `chrome.loadTimes()` timing API
4. **`chrome.runtime`** — fabricate `window.chrome.runtime` with `onConnect`/`id`, matching real Chrome structure
5. **`iframe.contentWindow`** — fix the tell where an iframe's `contentWindow` reports `null`/inconsistent prototype
6. **`media.codecs`** — patch `MediaSource.isTypeSupported` / `HTMLMediaElement.canPlayType` to real Chrome codec strings
7. **`navigator.hardwareConcurrency`** — set a plausible CPU-core count
8. **`navigator.languages`** — set `['en-US', 'en']` (avoid headless default)
9. **`navigator.permissions`** — patch `notifications` permission state to match headful behavior
10. **`navigator.plugins`** — synthesize a realistic `PluginArray` (headless exposes 0)
11. **`navigator.vendor`** — set `'Google Inc.'`
12. **`navigator.webdriver`** — remove the `true` flag (the big one)
13. **`sourceurl`** — clean the `//# sourceURL=__puppeteer_evaluation_script__` artifact
14. **`user-agent-override`** — strip `HeadlessChrome` from the UA + set language/platform
15. **`webgl.vendor`** — override WebGL renderer/vendor (headless says "Google"/SwiftShader)
16. **`window.outerdimensions`** — set non-zero `window.outerWidth/outerHeight`

(The older "11 modules" description omits `vendor`, `sourceurl`, `webgl.vendor`, and `outerdimensions`, which were added later.)

### 1.3 Code for the most important patches

**`navigator.webdriver`** — two-pronged, version-gated (source: `evasions/navigator.webdriver/index.ts`):

```ts
// onPageCreated: delete the property off the Navigator prototype
async onPageCreated(page: Page) {
  await page.evaluateOnNewDocument(() => {
    const nav = navigator as Navigator & { webdriver?: boolean }
    if (nav.webdriver === false) {
      // post Chrome 89.0.4339.0 — already good
    } else if (nav.webdriver === undefined) {
      // pre Chrome 89.0.4339.0 — already good
    } else {
      // pre Chrome 88.0.4291.0 — delete off the prototype
      delete Object.getPrototypeOf(nav).webdriver
    }
  })
}

// beforeLaunch: disable the Blink feature that sets it in the first place
async beforeLaunch(options: LaunchOptions) {
  options.args = options.args || []
  const idx = options.args.findIndex(
    arg => typeof arg === 'string' && arg.startsWith('--disable-blink-features=')
  )
  if (idx !== -1) {
    options.args[idx] = `${options.args[idx]},AutomationControlled`
  } else {
    options.args.push('--disable-blink-features=AutomationControlled')
  }
}
```

Why both? The **launch flag** fixes the value at the C++ source (no JS getter to notice) — the superior patch. The **`delete`** is the fallback for the rare path where the flag didn't take. The current version also wraps the getter in an **ES6 Proxy** (`replaceGetterWithProxy`) so `navigator.webdriver instanceof ...` and `Function.prototype.toString()` still look native:

```js
// utils.replaceGetterWithProxy — proxy the native getter so instanceof + toString pass
utils.replaceGetterWithProxy = (obj, propName, handler) => {
  const fn = Object.getOwnPropertyDescriptor(obj, propName).get
  const fnStr = fn.toString()
  const proxyObj = new Proxy(fn, utils.stripProxyFromErrors(handler))
  utils.replaceProperty(obj, propName, { get: proxyObj })
  utils.patchToString(proxyObj, fnStr)   // force toString() to the original string
  return true
}
```

**`chrome.runtime`** (fabrication, from `evasions/chrome.runtime/`):

```js
// Build a plausible chrome object with app/csi/loadTimes/runtime
const chrome = {
  app: { isInstalled: false, InstallState: {}, RunningState: {} },
  csi: { loadTimes: function () {} },
  loadTimes: function () {},
  runtime: {
    id: undefined,                        // real Chrome has no id unless an ext is installed
    onConnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: () => {}, removeListener: () => {} },
    sendRequest: () => {},
    connect: () => ({ onMessage: {}, onDisconnect: {} })
  }
}
// Define only what's missing, non-enumerable, so `for..in` doesn't expose it
if (!window.chrome) Object.defineProperty(window, 'chrome', { value: chrome, enumerable: true })
```

**`iframe.contentWindow`** — the isolation gap: the top-level patch runs on the main world, but an iframe gets a **fresh** `Navigator` prototype where `webdriver` is still `true`. The module re-applies the patch inside new iframes by wrapping the `contentWindow` getter:

```js
Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
  get() {
    const win = originalGet.call(this)
    try {
      Object.defineProperty(
        win.Navigator.prototype, 'webdriver',
        { get: () => undefined, configurable: true, enumerable: true }
      )
    } catch (e) { /* cross-origin iframe throws SecurityError — ignore */ }
    return win
  }
})
```

### 1.4 Residual tells the plugin itself introduces

- **Descriptor forensics:** real Chrome has *no* `webdriver` descriptor on the prototype; the patch *adds* one whose getter source is `"() => undefined"`. `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')` is non-`undefined`, and `getter.toString()` isn't `[native code]` → detectable.
- **iframe gap** above (fixed only for same-origin iframes).
- **`plugins instanceof PluginArray`** fails for fabricated arrays.
- **`chrome.runtime.onConnect`** own-keys are plain functions, not prototype methods.
- **source-map / `sourceURL`** artifacts from `evaluateOnNewDocument`.

---

## 2. playwright-stealth

`playwright-stealth` (in the `playwright-extra` ecosystem) is a near-port of `puppeteer-extra-plugin-stealth`. Same architecture: wrap Playwright, register the plugin, evasions run via `page.addInitScript(...)` **before any page script**.

**What it patches** (same module set as §1.2, Chromium-only): `navigator.webdriver`, `window.chrome` (app/csi/loadTimes/runtime), `navigator.plugins`, `navigator.languages`, `navigator.permissions`, WebGL vendor/renderer, `media.codecs`, `iframe.contentWindow`, `user-agent-override`, `window.outerdimensions`, `console.debug`.

**The `disableBlinkFeatures` approach:** it pushes `--disable-blink-features=AutomationControlled` into the launch `args` (identical mechanism to the Puppeteer plugin), so `navigator.webdriver` is never set at the source.

```js
const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromium.use(StealthPlugin())
const browser = await chromium.launch({ headless: true })   // args carry the flag
```

**Selective enable/disable** (same API as the Puppeteer side):

```js
const stealth_config = new Set([
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'navigator.webdriver',
  'navigator.plugins', 'navigator.languages', 'navigator.permissions',
  'navigator.vendor', 'user-agent-override', 'media.codecs', 'iframe.contentWindow'
])
chromium.use(new StealthPlugin({ enabledEvasions: stealth_config }))
```

**Comparison to puppeteer-extra:** behaviorally identical (both are page-injected monkey-patches). `playwright-stealth` has broader coverage than the Python `undetected-playwright` (6–7 core patches) but inherits the same ceiling: it cannot fix anything below the JS runtime, and its `addInitScript` runs in the main world where `MutationObserver` can see it.

Reported 2026 pass rates against live anti-bot vendors (Sendwin benchmark):

| Target | playwright-stealth | Patchright (CDP-fork) |
|---|---|---|
| Cloudflare standard | ~70–80% | ~90–95% |
| Cloudflare Turnstile | ~40–55% | higher |
| DataDome | ~30–50% | higher |
| PerimeterX / HUMAN | ~25–40% | higher |
| Akamai Bot Manager | ~35–50% | higher |

---

## 3. cdp-stealth / direct-CDP approaches

### 3.1 The `Runtime.enable` leak (the dominant 2024–2026 tell)

Puppeteer and Playwright drive Chrome over the **Chrome DevTools Protocol (CDP)**. To evaluate JS they need an `ExecutionContextId`, which they get by issuing `Runtime.enable`. That command turns on `Runtime.*` events — including the V8 inspector's **DevTools preview** of `console.*` arguments.

A detection challenge:

```js
const detected = (() => {
  let found = false
  try {
    Object.defineProperty(window, 'leakProbe', {
      get() {                       // fires only when the inspector serializes a preview
        console.log(new Error())    // serialization of error.stack triggers the getter
        return 42
      }
    })
    console.debug(window.leakProbe) // console.* + Runtime.enable => preview path => getter runs
  } catch (e) {}
  return found
})()
```

**Mechanism:** `Runtime.enable` → page calls `console.*` on a rigged object → V8 builds a rich preview for the (absent) DevTools panel → the getter trap fires → page now knows a protocol client is attached. This fires **regardless of which JS patches you applied**, because it's about the transport, not the fingerprint. (A 2025 Chrome change weakened the original check — DataDome documented the shift — but newer variants exploit slightly different CDP side effects.)

### 3.2 Fixing it at the CDP layer

**`rebrowser-patches`** (Node, patches `puppeteer-core`/`playwright` source): disables the automatic `Runtime.enable` per frame and acquires context IDs a different way. Three modes:

```bash
npx rebrowser-patches@latest patch --packageName puppeteer-core
```

```js
// env-controlled at runtime:
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding'   // default, keeps main world
// or 'alwaysIsolated' (scripts run in a Page.createIsolatedWorld) 
// or 'enableDisable' (enable then immediately disable)
```

- **`addBinding`** — create a `window` binding in the main world, call it, capture the context ID. Keeps main-world access; works with workers/iframes.
- **`alwaysIsolated`** — all scripts in an isolated world (page scripts can't see your mutations via `MutationObserver`), but you lose main-context variable access.
- **`enableDisable`** — enable then immediately disable to grab the ID (tiny leak window).

**`cdp-stealth`** (`kennyklee/cdp-stealth`) — a higher-level direct-CDP driver: connect to a manually-launched Chrome (`--remote-debugging-port=9222`) and apply `Page.addScriptToEvaluateOnNewDocument` patches for `navigator.webdriver`, plugins/languages/platform, WebGL, UA/headers, `chrome.runtime`, plus a **human-like behavior layer** (variable typing speed, mouse jitter). It explicitly does **not** do CAPTCHA or IP.

**`nodriver`** (Python, successor to undetected-chromedriver) — drops the chromedriver binary **and** Selenium, speaks raw CDP, avoids the naive `Runtime.enable`-on-every-frame pattern, so `navigator.webdriver` reads `false` and the startup handshake has no Playwright/ChromeDriver fingerprint.

### 3.3 The `addScriptToEvaluateOnNewDocument` primitive

Both plugin-style and CDP approaches converge on the same CDP method. It is the canonical place to inject `navigator.webdriver` and `AutomationControlled` overrides so they run **before** page scripts:

```js
// Puppeteer
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => undefined, configurable: true
  })
})

// Raw CDP (chromedp / puppeteer-core CDP client)
await client.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`
})
```

> Note: Puppeteer's `page.evaluate()` adds a `//# sourceURL=pptr:...` marker that detectors can read; `rebrowser-patches` rewrites this to a generic name.

---

## 4. `--disable-blink-features=AutomationControlled`

**What it hides:** `AutomationControlled` is a **Blink feature flag** that Chrome enables during automation. Disabling it stops Chromium from setting `navigator.webdriver === true` in the first place — the highest-leverage single flag, because the value is fixed at the C++ layer rather than overwritten in JS (no redefined getter to notice).

**Limitations:**
- Historically triggers a **"unsupported command-line flag" infobar** on Linux (suppressible via enterprise policy `CommandLineFlagSecurityWarningsEnabled: false`, or `--disable-infobars` which is deprecated).
- Does **not** remove the `HeadlessChrome` brand entry that `navigator.userAgentData.getHighEntropyValues()` exposes — a parallel automation channel.
- Does **not** touch the CDP `Runtime.enable` leak, TLS/JA4, plugins, WebGL, or behavioral signals.
- On **new headless mode** (`--headless=new`, Chrome 109+, runs the same binary as headful) many of these leaks were already closed by Google, so the flag partly duplicates native behavior — but the CDP and brand tells remain.

---

## 5. Real-world effectiveness (2024–2026)

### 5.1 What still gets caught despite the patches

Production detectors run **five layered signal classes**; no single one is reliable, but the distribution is:

1. **CDP attachment** — `Runtime.enable` side effects and variants (most reliable JS tell).
2. **Headless-mode artifacts** — `HeadlessChrome` brand in `userAgentData`, `navigator.webdriver` descriptor shape, `plugins instanceof PluginArray`.
3. **TLS / HTTP/2 fingerprint** — **JA4/JA3** (cipher suites, extensions, ALPN, ordering) and HTTP/2 SETTINGS frame ordering fingerprint the HTTPS client. A headless-Chrome JA4 differs measurably from real Chrome.
4. **Datacenter IP + ASN** — a Chrome UA from a Hetzner/AS-owned IP is an instant contradiction.
5. **Behavioral absence** — mouse/scroll/focus event distributions, timing, lack of real input.

And the **patch's own artifacts**: `Object.getOwnPropertyDescriptor` shape, `Function.prototype.toString()` on a patched getter, `MutationObserver` visibility of injected scripts, iframe isolation gaps.

### 5.2 Benchmarks / comparisons (2026)

**Ian L. Paterson — Anti-detect browser benchmark (May 2026):** 7 tools × 31 Cloudflare-protected targets × 3 sweeps = 651 verdicts, from one residential IP:

| Tool | OK | Gated | Blocked | Engine |
|---|---|---|---|---|
| **nodriver** | **28** | 3 | **0** | system Chrome 148 over direct CDP |
| CloakBrowser | 26 | 3 | 2 | patched Chromium 145 fork (49 C++ mods) |
| curl_cffi | 26 | 3 | 2 | HTTP-only, `impersonate="chrome"` |
| Patchright | 25 | 3 | 3 | Chrome 148 via `channel=chrome` |
| Camoufox | 25 | 3 | 3 | Firefox 135 fork |
| vanilla Playwright | 24 | 2 | 5 | Chromium 147 |
| **rebrowser-playwright** | **24** | **2** | **5** | Chromium 136 (unmaintained since Sept 2024) |

**Key finding:** the dominant axis is **automation-protocol fingerprinting**, not static fingerprints. `rebrowser-playwright` scored *identically to vanilla Playwright* — its CDP-leak patches changed nothing on this matrix. Only `nodriver` (no Playwright shim in the control plane) achieved zero blocked cells.

**Sendwin — Patchright vs playwright-stealth (2026):** vanilla stealth ~25–55% pass across Cloudflare/DataDome/PerimeterX/Akamai; Patchright ~90–95% on Cloudflare standard.

**Castle / DataDome / deviceandbrowserinfo (2024–2025):** establish the detection hierarchy (UA → `navigator.webdriver` → CDP) and document the 2025 Chrome change that weakened the original `Runtime.enable` check.

**Takeaway:** JS-layer stealth is necessary but insufficient against modern anti-bot. TLS/JA4, IP reputation, and the CDP handshake dominate.

---

## 6. Maintenance reality

- **Version lag is structural.** `puppeteer-extra-plugin-stealth` has had **no substantive update since mid-2024**; its patch list froze while detection grew. `rebrowser-playwright` last committed Sept 2024 (Chromium 136, ~12 versions stale). Every plugin/patch is a moving target against upstream Puppeteer/Playwright releases and Chrome versions.
- **Patching internal properties vs. maintaining a fork:**
  - *Page-injected monkey-patches* (plugins): cheap, portable, but detectable via descriptor/`toString`/`MutationObserver`, and **blind** to anything below JS.
  - *Driver-source patches* (`rebrowser-patches`, `Patchright`): fix the CDP leak at the protocol layer — the part that actually matters — but are **fragile**: a `npm install` or upstream release can revert/patch over them, and they must be re-applied.
  - *Binary/CDP-layer forks* (`CloakBrowser`, `Camoufox`, `nodriver`): closest to "real," but heavier, less feature-complete, and (often) non-Node or AGPL-licensed.
- **Production architecture for a Node MCP server** (this project's case):
  1. **Isolate** stealth into a single module with a clear interface (`StealthProfile` → launch args + init-script source). Keep it **feature-flagged** (`SMOOTH_OPERATOR_STEALTH=on|off|minimal`) so it can be toggled per-deployment.
  2. **Degrade gracefully:** if a patch throws or a flag is rejected, launch still succeeds with the reduced set; never let stealth startup fail the whole browser.
  3. **Prefer fewer, coherent patches over a pile of monkey-patches** — new headless Chrome already fixes many things, so an over-patched profile can be *worse* (more residual artifacts).
  4. **Separate the fixable from the unfixable:** JS tells are patchable; TLS/JA4/IP/behavior are not. Surface IP/reputation and behavioral layers as **separate concerns** (proxy config, pacing), not as stealth-plugin problems.
  5. **Pin + verify:** pin the Puppeteer-core version, apply driver patches in a build step, and add a **self-test** (rebrowser-bot-detector-style checks) to CI so version drift is caught before release.

---

## 7. Recommended modern recipe (Puppeteer-core ^25 + full Chrome)

Goal: minimal, maintainable, coherent. Run **full Chrome** (`channel`-equivalent: point at the system Chrome binary) rather than the headless shell, and patch only what JS can reach.

### 7.1 Launch flags

```js
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled', // hides navigator.webdriver at source
  '--no-first-run',
  '--no-default-apps',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  // '--headless=new',  // optional: same binary as headful, closes many native gaps
]
```

> If you must use the headless shell, add `--headless=new` (Chrome 109+): `window.chrome`, `navigator.plugins`, and permissions are already populated, so you can *drop* several evasion modules.

### 7.2 Init-script bundle (evaluated on every new document)

```js
const STEALTH_INIT_SOURCE = `
(function () {
  // 1. navigator.webdriver -> undefined (fallback if the launch flag didn't take)
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined, configurable: true, enumerable: true
    });
  } catch (e) {}

  // 2. window.webdriver
  try { Object.defineProperty(window, 'webdriver', { value: undefined, configurable: true }) } catch (e) {}

  // 3. Strip the HeadlessChrome token from the UA + userAgentData brands
  const ua = navigator.userAgent;
  if (/HeadlessChrome/.test(ua)) {
    Object.defineProperty(navigator, 'userAgent', { value: ua.replace('HeadlessChrome', 'Chrome'), configurable: true });
  }

  // 4. Plugins: keep native if present, else leave alone (new headless already populates)
  // 5. chrome.runtime shim (only if absent)
  if (!window.chrome || !window.chrome.runtime) {
    Object.defineProperty(window, 'chrome', {
      value: { runtime: { id: undefined, onConnect: {}, onMessage: {}, sendRequest() {}, connect() { return { onMessage: {}, onDisconnect: {} } } } },
      enumerable: false, configurable: true
    });
  }
})();
`;
```

Register it once per page:

```js
await page.evaluateOnNewDocument(STEALTH_INIT_SOURCE);
```

### 7.3 Coherent fingerprint (one set, never individual)

A lone `--user-agent` override is usually *worse* than none — it makes the profile rarer. Set UA, client hints, locale, viewport, DPR, and touch together:

```js
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.setViewport({ width: 1920, height: 1080, devicePixelRatio: 1 });
// Accept-Language / locale via launch --lang=en-US
```

### 7.4 Closing the CDP leak (if Puppeteer-core must stay under CDP)

Two options, in order of preference:

```js
// Option A — patch the driver once (rebrowser-patches), then keep code unchanged:
//   npx rebrowser-patches@latest patch --packageName puppeteer-core
//   // env: REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding  (default)

// Option B — avoid the leak by creating an isolated world for your own scripts:
const ctx = await page.createIsolatedWorld('stealth', {});
const result = await ctx.evaluate(() => navigator.webdriver); // no main-world Runtime.enable
```

### 7.5 Human-like behavior layer (the cheapest high-leverage addition)

```js
async function humanDelay(ms = 400, variance = 250) {
  await new Promise(r => setTimeout(r, ms + Math.random() * variance * 2 - variance));
}
// random scroll increments, small mouse jitter, focus/blur, realistic key delays.
```

### 7.6 Feature-flagged integration sketch (fits the MCP server)

```ts
interface LaunchConfig {
  stealth: 'off' | 'minimal' | 'full'   // env: SMOOTH_OPERATOR_STEALTH
  executablePath?: string                 // system Chrome => real Chrome TLS/version stamp
}

function buildStealthOptions(cfg: LaunchConfig) {
  const args = [...DEFAULT_ARGS]
  if (cfg.stealth !== 'off') args.push('--disable-blink-features=AutomationControlled')
  try {
    return { args, initSource: cfg.stealth === 'off' ? null : STEALTH_INIT_SOURCE }
  } catch (e) {
    // degrade gracefully: return flags, drop init script
    return { args, initSource: null }
  }
}
```

---

## Sources

- berstend, `puppeteer-extra-plugin-stealth` README + evasion source: github.com/berstend/puppeteer-extra/.../puppeteer-extra-plugin-stealth
- The Audit Veteran, *Deconstructing the Puppeteer Stealth Plugin* (2026): theauditveteran.com
- Foil, *Puppeteer bot detection* (2026): usefoil.com
- Rebrowser, *How to fix Runtime.Enable CDP detection*; `rebrowser-patches` README: rebrowser.net / github.com/rebrowser/rebrowser-patches
- Castle, *Detect Headless Chrome bots instrumented with Puppeteer/Playwright* (2025): blog.castle.io
- DataDome / Antoine Vastel, *How New Headless Chrome & the CDP Signal Impact Bot Detection*
- deviceandbrowserinfo, *Detecting headless Chrome instrumented with Puppeteer (2024 edition)*
- Ian L. Paterson, *Anti-detect browser benchmark 2026* (651 verdicts): ianlpaterson.com
- Sendwin, *Patchright vs Playwright Stealth (2026)*: blog.send.win
- Serpent API, *Does Puppeteer Stealth Still Work in 2026?*: apiserpent.com
- `feder-cr/invisible_playwright` — *puppeteer-extra-plugin-stealth: unmaintained since 2024*
- `ultrafunkamsterdam/nodriver`, `Kaliiiiiiiiii-Vinyl/patchright`, `zfcsoftware/puppeteer-real-browser`, `kennyklee/cdp-stealth`

*Note on sourcing: several 2026-dated blog/benchmark pieces are community-written and self-reported; pass-rate numbers are directional, not audited. Cross-check any vendor figure before relying on it.*
