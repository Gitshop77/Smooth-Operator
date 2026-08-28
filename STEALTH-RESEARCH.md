# Stealth / Anti-Detection for Puppeteer + Chromium — Technical Research Report

> Research report for building legitimate stealth in a headless/headed browser automation MCP.
> Scope: Puppeteer + Chromium/Chrome. Legitimate automated-testing quality focus.
> Compiled from primary sources: `puppeteer-extra-plugin-stealth` source, FingerprintJS, Paul Irish's
> `headless-cat-n-mouse`, Intoli, Antoine Vastel/Castle, Browserless, Foil, and detector writeups.

---

## TL;DR — The layered model

Modern anti-bot systems score a session across **independent layers** and block on *coherence*
(impossible combinations), not single values:

| Layer | Signals | Patchable from JS? |
|---|---|---|
| Network | IP reputation, ASN, TLS (JA3/JA4), HTTP/2 SETTINGS, header order | ❌ (engine-level) |
| Protocol | TLS ClientHello, ALPN, TCP options, SNI | ❌ |
| JS runtime | `navigator.webdriver`, plugins, mimeTypes, `window.chrome`, permissions, WebGL strings | ⚠️ partially (see caveats) |
| Rendering | canvas/WebGL/audio pixel hashes | ⚠️ (noise vs. stability tradeoff) |
| Behavioral | mouse curves, typing variance, scroll, timing | ❌ from JS alone |
| Automation artifact | CDP side-effects, `HeadlessChrome` UA brand | ⚠️ partial |

**Key insight (Castle, crawlex):** each JS patch closes a *value-level* leak but opens a smaller
*behavior-level* leak (a `Proxy` where a native method should be, a scrubbed error stack). Detection
has moved from reading values to reading the "texture" of the runtime. The only patches that change
*what Chrome is* (not *what it says*) are launch-argument patches — most notably
`--disable-blink-features=AutomationControlled` and `--headless=new`.

---

## 1. User-Agent strategy

### Why UA alone is insufficient (and dangerous)

The UA string is a *claim*. The TLS handshake (see §4) is *evidence* produced before any header
exists. A UA that disagrees with the engine's real fingerprint is itself the tell. So UA work is
about **consistency across every surface that advertises the browser**, not just one string.

Surfaces that must agree:
1. `navigator.userAgent` (JS)
2. The `User-Agent` HTTP request header
3. Client Hints: `Sec-CH-UA`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Full-Version-List`
4. `navigator.userAgentData` (HighEntropySignals brand list)
5. `Accept-Language` header
6. `navigator.platform` / `userAgentData.platform`

### Best practices

- **Match UA to the actual bundled Chrome version.** Pull the version from the browser binary, don't
  hardcode. A UA claiming `Chrome/145` off a `Chrome/128` binary is a `userAgentData`/version-drift
  mismatch.
- **Keep the `HeadlessChrome` token problem in mind.** Headless Chrome appends `HeadlessChrome/<v>`
  to the UA (see §7). Spoofing the string in JS is not enough — `userAgentData` brand list also
  carries a `HeadlessChrome` brand that survives `--disable-blink-features`.
- **Build proper Client Hints brands array.** Chrome expects the high-entropy `Sec-CH-UA` to be
  derivable from a brands list like:

```js
[
  { brand: 'Chromium', version: '145' },
  { brand: 'Google Chrome', version: '145' },
  { brand: 'Not=A?Brand', version: '8' }
]
```

- **Mobile vs desktop consistency:** a mobile UA (`Android`, `Mobi`) must not pair with
  `userAgentData` desktop signals, and vice versa.

### Puppeteer: set UA + Client Hints together

`page.setUserAgent()` accepts a second arg `userAgentMetadata` that sets the Client Hints. Omit it
and `Sec-CH-UA` headers won't match your UA → mismatch.

```js
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const chromeVersion = '145';

await page.setUserAgent(UA, {
  brands: [
    { brand: 'Chromium', version: chromeVersion },
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Not=A?Brand', version: '8' }
  ],
  platform: 'Windows',          // -> navigator.userAgentData.platform
  mobile: false,
  platformVersion: '10.0.0',
  architecture: 'x86',          // -> Sec-CH-UA-Architecture
  bitness: '64',                // -> Sec-CH-UA-Bitness
  model: ''                     // -> Sec-CH-UA-Model
});
```

`puppeteer-extra-plugin-stealth`'s `user-agent-override` module does this coordination
automatically (UA + language + platform + Client Hints), which is why manual overrides are usually
only needed for bespoke profiles.

### `navigator.userAgentData` (WebIDL hints)

`NavigatorUserAgentData.getHighEntropyValues(['brands','fullVersionList','platform',
'architecture','bitness'])` returns the machine-readable browser identity. It is populated from the
same launch-time data as the UA, so a spoofed UA string that isn't reflected into `userAgentData`
is caught. There is no reliable JS-level patch (getter is native, version-dependent), so consistency
is achieved at launch, not in-page.

---

## 2. navigator / WebIDL spoofing

### What detectors read (the leak catalog)

| Property | What headless leaks | Detector signal |
|---|---|---|
| `navigator.webdriver` | `true` under CDP | Primary check, first thing read |
| `navigator.plugins` / `mimeTypes` | length 0 in headless | Empty PluginArray = bot |
| `window.chrome` | missing/hollow | Missing `chrome.runtime` etc. |
| `navigator.languages` | `['en-US']` or sparse | Language header mismatch |
| `navigator.vendor` | sometimes empty | UA/vendor consistency |
| `navigator.permissions` | `query` disagrees with `Notification.permission` | Impossible combination |
| `navigator.deviceMemory` | often `4`, server mismatch | Castle deep-dive signal |
| `navigator.hardwareConcurrency` | 1–2 (VPS) | Cloud/VM tell |
| `navigator.maxTouchPoints` | 0 on desktop servers | Inconsistent with platform |
| `Intl` / `resolvedOptions` | locale/timezone defaults | Geo mismatch |
| `navigator.userAgentData` | `HeadlessChrome` brand | UA-token leak (see §7) |
| HTMLMediaElement.canPlayType | codec list | proprietary codec check |
| `iframe.contentWindow` | `srcdoc` frames leak identity | cross-frame check |

### The injection model (why timing is everything)

Every evasion is delivered via `page.evaluateOnNewDocument()` — Puppeteer's wrapper for the CDP
`Page.addScriptToEvaluateOnNewDocument`. The patch runs in the page's **main world** before any page
script, so it wins the race by construction. But because it runs in the *same* context the detector
reads from, the spoof must also hide itself.

Three shared helpers do most of the "hiding" work (`_utils` in the plugin):

- **`makeNativeString(fnName)`** → returns `'function fnName() { [native code] }'` so a wrapped
  method can lie about its own source.
- **`patchToString`** → a proxy around `Function.prototype.toString`; calling `.toString()` on a
  patched function returns the native-code string instead of the JS body.
- **`stripProxyFromErrors`** → wraps every `Proxy` trap in try/catch and rewrites the exception's
  stack, deleting frames that name the proxy/helper file.

### Patch approach for the top ~10

**1. `navigator.webdriver`** — two-pronged, version-split (source: `evasions/navigator.webdriver`):

```js
// onPageCreated — property deletion (Chrome < 88 path, and belt-and-suspenders)
await page.evaluateOnNewDocument(() => {
  delete Object.getPrototypeOf(navigator).webdriver;
});
```
```js
// beforeLaunch — disable the Blink feature so Chrome never sets it (Chrome 88+, the good fix)
options.args.push('--disable-blink-features=AutomationControlled');
// or append if a --disable-blink-features already exists:
//   --disable-blink-features=Foo,AutomationControlled
```
Modern Chrome (89+) already returns `false`/`undefined`; the module detects and no-ops. The launch
flag is strictly better than JS deletion because it leaves no redefined getter to probe.

**2. `navigator.plugins` / `mimeTypes`** — rebuild `PluginArray`/`MimeTypeArray` from a captured
`data.json`. The hard part is the **bidirectional cross-reference**: each `Plugin` points at its
`MimeType`s, each `MimeType.enabledPlugin` points back. A detector follows plugin→mimeType→plugin
and must land on the same object. Reuse proxy refs for circular entries so the loop closes.
Headless now populates these in `--headless=new`, so this is often redundant (see §7).

**3. `window.chrome` (`chrome.app`, `chrome.csi`, `chrome.loadTimes`, `chrome.runtime`)** — fabricate
the object from a JSON snapshot + working method stubs. `runtime.sendMessage` validates arg lengths
and throws the correct `TypeError`; `runtime.connect` returns a dead port with wired listeners.
**Secure-origin guard:** `chrome.runtime` is only populated on HTTPS — the patch skips HTTP pages
unless `runOnInsecureOrigins` is set, matching real Chrome.

**4. `navigator.languages`** — set to a realistic array (e.g. `['en-US', 'en']`) matching the
`Accept-Language` header and geo.

**5. `navigator.vendor`** — force `'Google Inc.'` for consistency with the UA.

**6. `navigator.permissions`** — patch the **permissions contradiction**. Real Chrome agrees across
`Notification.permission` and `navigator.permissions.query({name:'notifications'})`; headless made
them disagree (an impossible combination). The patch wraps `Permissions.prototype.query`, and on an
insecure origin returns a `PermissionStatus`-shaped object (`state: 'denied'`) whose prototype is
`PermissionStatus.prototype` so `instanceof` passes:

```js
// simplified shape of the evasion
Permissions.prototype.query = function (query) {
  if (query.name === 'notifications' && location.protocol !== 'https:') {
    return Promise.resolve(new PermissionStatus({ state: 'denied' }));
  }
  return originalQuery(query);
};
```

**7. `navigator.hardwareConcurrency` / `deviceMemory` / `maxTouchPoints`** — redefined via
`Object.defineProperty` with realistic desktop values (e.g. `hardwareConcurrency: 8`,
`deviceMemory: 8`, `maxTouchPoints: 0` on desktop). Constraints: `deviceMemory` must be one of
`{0.25, 0.5, 1, 2, 4, 8}` (Castle: any other value = spoofed).

**8. `media.codecs` (`HTMLMediaElement.canPlayType`)** — spoof proprietary codec support
(`video/mp4; codecs="avc1.42E01E"`, `video/webm`, etc.) that headless Chromium reports as absent.

**9. `iframe.contentWindow`** — proxy the `contentWindow` getter for `srcdoc` frames: redirect
`self` to the proxied window, point `frameElement` back at the iframe, hide stray enumerable props
(e.g. a numeric `0`). Only `srcdoc` frames are affected; URL-loaded iframes are left alone.

**10. `Intl` / locale** — ensure `Intl.DateTimeFormat().resolvedOptions().timeZone` and
`navigator.language` match the claimed geo; set `--lang` at launch and the UA languages in-page.

### The residual-problem caveat (important)

Each patch replaces a native getter/method with a JS `Proxy`. Detectors probe the *texture*:
`Function.prototype.toString` (defeated by `patchToString`), error-stack frames (defeated by
`stripProxyFromErrors`), property descriptors, and timing of the indirection. As Castle states,
"there is no official API to inspect a proxy, but a proxy can still be detected indirectly through
these side effects." Over-patching a browser that was already correct (new headless, §7) *increases*
detection surface.

---

## 3. Canvas / WebGL / Audio noise

Fingerprinters render a canonical scene and hash the pixel/audio output — hardware-dependent, so
they identify the *device*, not just the browser.

### How each is captured

```js
// Canvas: draw a fixed scene, hash toDataURL
const c = document.createElement('canvas'); c.width = 256; c.height = 256;
const ctx = c.getContext('2d');
ctx.textBaseline = 'top'; ctx.font = '14px Arial';
ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
ctx.fillStyle = '#069'; ctx.fillText('Ccm fjordbank glyphs vext quiz', 2, 15);
ctx.beginPath(); ctx.arc(50, 50, 50, 0, Math.PI*2); ctx.fill();
const hash = sha1(c.toDataURL());   // GPU/driver-dependent

// WebGL: read UNMASKED strings via debug extension
const gl = c.getContext('webgl');
const ext = gl.getExtension('WEBGL_debug_renderer_info');
const vendor   = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);   // 37445
const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); // 37446

// Audio: render an inaudible signal through OfflineAudioContext, hash the waveform
const ac = new OfflineAudioContext(1, 44100, 44100);
const osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
const comp = ac.createDynamicsCompressor();
osc.connect(comp); comp.connect(ac.destination); osc.start(0);
const buf = await ac.startRendering();
const sum = Array.from(buf.getChannelData(0).slice(4500, 5000))
                 .reduce((a, v) => a + Math.abs(v), 0);
```

### Techniques

**a. WebGL vendor/renderer spoofing** — hook `getParameter` on both `WebGLRenderingContext` and
`WebGL2RenderingContext` (the stealth `webgl.vendor` module defaults to `Intel Inc.` /
`Intel Iris OpenGL Engine`, configurable per platform):

```js
const handler = {
  apply(target, _, args) {
    if (args[0] === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
    if (args[0] === 37446) return 'Intel(R) Iris(TM) Plus Graphics 655'; // UNMASKED_RENDERER_WEBGL
    return Reflect.apply(target, _, args);
  }
};
for (const Ctx of [WebGLRenderingContext, WebGL2RenderingContext]) {
  Object.defineProperty(Ctx.prototype, 'getParameter', {
    value: new Proxy(Ctx.prototype.getParameter, handler),
    configurable: true, enumerable: false, writable: false
  });
}
```

**The hard limit:** swapping two strings changes nothing about the *rendered pixels*. SwiftShader
(software rasterizer) produces different pixels than a real Intel/Apple GPU — antialiasing and FP
rounding included. So a renderer string saying "Intel Iris" while pixels say "software rasterizer"
is the impossible-combination signal. **Match the claimed GPU to the real hardware**, or accept the
mismatch.

**b. Deterministic canvas/audio noise** — add imperceptible per-pixel noise so the hash varies,
*but keep it stable within a session* (Brave/uBlock-style). Critical: noise must be **deterministic
per session**, not random every read — otherwise the hash changes between calls and is flagged as
"unstable" (CreepJS), which is itself a bot signal.

```js
// addInitScript — session-stable noise (seed the seed once per session)
HTMLCanvasElement.prototype.toDataURL = function (type) {
  const ctx = this.getContext('2d');
  if (ctx && this.width > 0 && this.height > 0) {
    const img = ctx.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i]   += Math.floor(Math.random() * 3) - 1; // R,G,B
      img.data[i + 1] += Math.floor(Math.random() * 3) - 1;
      img.data[i + 2] += Math.floor(Math.random() * 3) - 1;
    }
    ctx.putImageData(img, 0, 0);
  }
  return originalToDataURL.apply(this, arguments);
};
```
Add noise to `getImageData` too (some detectors read raw pixel arrays). Keep amplitude small
(±1–2) — enough to defeat fixed-hash trackers, little enough to stay visually identical.

**c. `--disable-blink-features=AutomationControlled`** — primarily the webdriver flag, but part of
the rendering-environment cleanup (see §6).

**d. `Emulation.setDeviceMetricsOverride` (CDP)** — pin viewport/device so `screen`,
`devicePixelRatio`, and layout match a real device. Without it, headless reports a default
`800×600`/`1.0` DPR that doesn't match a claimed 1080p monitor.

```js
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
// Or via raw CDP for finer control:
await client.send('Emulation.setDeviceMetricsOverride', {
  width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false
});
```

**e. Enable GPU / avoid SwiftShader** — force hardware rendering so WebGL/canvas pixels come from a
real GPU instead of software. In Puppeteer: `--use-gl=angle` / `--use-angle=swiftshaderllvm` (or
`-gl=d3d11`/`opengl` on Windows/Mac), `--enable-vulkan`, `--force-color-profile=srgb`,
`--disable-features=RenderDevice`. On headless Linux servers without a GPU you often must pair a
spoofed renderer string with the *knowledge* that pixels will be SwiftShader — i.e. accept a
rendering-layer leak, or use a headed browser on a virtual display (Xvfb) / cloud GPU.

---

## 4. TLS / HTTP fingerprint (JA3 / JA4 / tlspuffin)

### Why it reveals headless even with a spoofed UA

The TLS handshake opens with `ClientHello`, listing cipher suites, extensions, curves, and point
formats **in order** — a property of the compiled TLS library, produced *before any HTTP header
exists*. JavaScript never sees it and cannot change it.

- **JA3** (Salesforce, 2017): MD5 of 5 comma-fields — TLS version, cipher list, extension list,
  elliptic curves, point formats. Hashes extensions in *wire order*.
- **JA4** (FoxIO, 2023): sorts cipher+extension lists before hashing, so Chrome's per-connection
  extension randomization (on by default since Chrome 110) collapses to one value; adds ALPN, SNI,
  TCP/HTTP-2 context. 36-char, human-readable (`JA4_a_JA4_b_JA4_c`).

Chrome uses **BoringSSL**; its cipher/extension set is consistent per version but differs across OS
(Windows injects ciphers via CryptoAPI; macOS reorders extensions). Headless Chromium on a Linux
server produces the "Linux headless" JA3 profile — which, paired with a Windows/macOS UA, is an
immediate **JA3-UA mismatch** detectable before a single byte of HTML is served.

### Approaches

1. **Use a real browser binary** (Chromium/Chrome via Puppeteer). The handshake comes from the
   engine's BoringSSL, not Node's TLS — already far more browser-like than a raw HTTP client. This
   is the single highest-leverage move for TLS.
2. **Use `--headless=new`** — shares the headful binary's TLS init path (see §7), closer to desktop.
3. **Impersonation HTTP clients** for non-JS requests: `curl-impersonate` (lwthiker) and
   `tls-client` replicate a specific browser's ClientHello + HTTP/2 SETTINGS + header order at the
   connection level — closing the JA3/JA4 gap *without* a browser, cheaply.
4. **Managed platforms** (Browserless/BQL, Scrapfly cloud, etc.) maintain tuned TLS/HTTP-2 profiles
   and offload the handshake.

### What's feasible inside Puppeteer

| Technique | Feasible in Puppeteer? | Notes |
|---|---|---|
| Get a real Chrome TLS stack | ✅ (use real Chrome, not system Node) | Highest leverage |
| Match desktop OS JA3 | ⚠️ partial | `--headless=new` + real Chrome approaches desktop; Linux servers still emit Linux profile |
| Rewrite cipher list / extensions | ❌ from JS | Decided at engine level |
| Handshake impersonation | ❌ | Needs a custom TLS build or `curl-impersonate`-style client |
| HTTP/2 SETTINGS alignment | ⚠️ partial | Mostly engine-driven; managed platforms handle it |

**Coherence rule (invisible_playwright / Foil):** the UA is a *claim*, the handshake is *evidence*.
A Firefox UA over a Chrome handshake (or a Chrome UA over a Python `requests` handshake) is a
contradiction a detector catches by eye. "You match a fingerprint by *being* the thing that has it,
not by describing it." So: don't hand-tune a TLS fingerprint to a browser family your engine isn't;
just run the real engine and don't disturb the agreement from above.

**tlspuffin** (the reference tool that *measures* TLS fingerprints) is used to characterize and
reproduce a target browser's fingerprint — run it against your browser and a reference build to
diff JA3/JA4 byte-for-byte.

**Client Hints coherence** (companion to TLS): servers send `Accept-CH`; real Chrome replies on the
next request with `Sec-CH-UA-Full-Version-List` etc. A headless stack that doesn't honor the
challenge returns nothing — a detectable gap. Configure high-entropy hints and honor `Accept-CH`.

---

## 5. Behavioral realism

No JS patch fakes how a session *moves*. Behavioral biometrics (mouse curves, typing, scroll,
timing) is the hardest layer and the last to fall.

### Mouse movement — Bezier curves + human jitter

Real cursors are **not straight lines**; they accelerate/decelerate with arcs and micro-jitter.
Replace linear tweening with cubic Bezier interpolation and add per-step Gaussian noise.

```js
// Move from (x1,y1) to (x2,y2) over `duration`ms with human-like motion
async function humanMouseMove(page, x1, y1, x2, y2, duration = 600) {
  const steps = Math.max(4, duration / 16);          // ~60fps
  // Control points create the characteristic arc (bezier)
  const cx1 = x1 + (x2 - x1) * 0.25 + rand(-30, 30);
  const cy1 = y1 + (y2 - y1) * 0.25 + rand(-60, 20);  // upward bulge
  const cx2 = x1 + (x2 - x1) * 0.75 + rand(-30, 30);
  const cy2 = y1 + (y2 - y1) * 0.75 + rand(-20, 40);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const b = t => (1-t)**3*   y1 + 3*(1-t)**2*t*cy1
                      + 3*(1-t)*t*t*cy2 + t**3*     y2;
    const bx = t => (1-t)**3*   x1 + 3*(1-t)**2*t*cx1
                      + 3*(1-t)*t*t*cx2 + t**3*     x2;
    const jitterX = rand(-2, 2), jitterY = rand(-2, 2);
    await page.mouse.move(bx(t) + jitterX, b(t) + jitterY);
    await sleep(rand(8, 20));
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
```
The `ghost-cursor` library implements this pattern (cubic Bezier + jitter + variable speed) and is
the reference implementation to port.

### Typing variance

`page.type` with a fixed `delay` is a dead giveaway. Use per-keystroke random delays plus occasional
"thinking" pauses and backspaces.

```js
async function humanType(page, selector, text) {
  await page.focus(selector);
  for (const ch of text) {
    await page.keyboard.press(ch);
    await sleep(rand(45, 160));          // human keystroke interval
    if (Math.random() < 0.08) await sleep(rand(300, 900)); // occasional think-pause
  }
}
```
Vary by character (vowels typed slower than consonants is a real measured effect) for extra realism.

### Scroll behavior

Real scrolling has momentum, pauses, and overshoot — not a single `window.scrollBy(0, 100000)`.
Scroll in variable increments, sometimes upward, with random pauses; scroll stops near content, not
always to the absolute bottom.

### Consistency surfaces

- **Viewport/screen:** `screen.width/height`, `devicePixelRatio`, and layout viewport must agree
  (see §3d).
- **Timezone/language:** `Intl` timezone + `navigator.language` + `Accept-Language` + IP geo must
  all point at the same region. A London IP with `America/New_York` timezone is a coherence fail.
- **Cookie/session warmup:** brand-new profiles every run look like fresh bots each visit. Reuse
  persistent profiles (`--user-data-dir`) and warm sessions with a few real navigations before the
  target, so cookie/storage history looks lived-in.

### Timing

Avoid perfectly consistent inter-action delays and instant-after-load clicks. Add randomized
"think time" (hundreds of ms to seconds) between actions. Timing attacks (`requestAnimationFrame`
gaps, `performance.now()` granularity) are subtle but real (see §3's SwiftShader timing note).

---

## 6. Flags that help / hurt

| Flag | Effect on stealth | Notes |
|---|---|---|
| `--headless=new` | ✅ **Big help** | Same binary as headful; `window.chrome`, plugins, permissions all correct; closer TLS/HTTP init. Prefer over legacy. |
| `--disable-blink-features=AutomationControlled` | ✅ **Big help** | Stops Chrome from setting `navigator.webdriver` at the source. Historically shows an automation infobar (suppress via Linux policy). |
| `--user-data-dir=<persistent>` | ✅ Helps | Reused profile → cookie/storage history looks human; avoid a fresh dir every run. |
| `--lang=<cc>` | ✅ Helps | Sets `navigator.language`/`Intl` to match geo; must agree with UA. |
| `--window-size=W,H` | ✅ Helps | Consistent viewport/screen; pairs with `setViewport`. |
| `--no-sandbox` | ⚠️ Neutral/minor | Needed in containers/root; not a detector by itself, but some hardening configs flag its absence. Use only where required. |
| `--disable-dev-shm-usage` | ⚠️ Neutral | Prevents `/dev/shm` crashes in low-memory containers; cosmetic to detectors. |
| `--export-tagged-linux-sandbox` | ⚠️ Minor | Controls Linux sandbox tagging; affects process namespace visibility, low detection impact. |
| `--headless` (legacy) / `headless: true` old path | ❌ Hurts | Stripped-down binary with dozens of JS differences; the whole reason the stealth plugin existed. |
| `--disable-extensions` (default) | ⚠️ | Real users often have extensions that alter TLS extension order; absence is a minor signal. |
| `--enable-automation` | ❌ Hurts | Adds the `Automation` infobar + `navigator.webdriver`; stealth's `defaultArgs` module removes it. |
| `--user-agent=<str>` | ⚠️ | Sets UA but *not* Client Hints → mismatch. Use `page.setUserAgent(UA, metadata)` instead. |

**Flag interaction caution:** flags change *what Chrome is*, which can make in-page patches redundant
or contradictory. E.g. on `--headless=new`, `navigator.plugins` is already populated, so the stealth
`navigator.plugins` proxy overwrites a correct value — increasing detection surface. On new headless,
**fewer patches is often better.**

---

## 7. headless shell detection (`headless=new` vs old headless)

### The two modes

- **Old headless (`--headless`, legacy):** a *separate, stripped-down* binary (`headless_shell`)
  that differed from desktop Chrome in dozens of small ways — missing `window.chrome`, empty
  plugins, divergent permissions, SwiftShader-only WebGL, a `HeadlessChrome` UA token, etc. This was
  the entire target of the stealth plugin (2017–2022).
- **New headless (`--headless=new`, renamed from `--headless=chrome` in Chrome 109):** runs the
  **same binary as headful** with the window simply not drawn. Fingerprint measured by Antoine Vastel
  (Castle/DataDome, 2023) as *close to a normal desktop Chrome*. Many of the old leaks auto-resolve:
  `window.chrome` present, `navigator.plugins` populated, permissions APIs agree, WebGL can reach a
  real GPU.

### How detectors distinguish them

1. **UA token.** Old headless appends `HeadlessChrome/<v>` to the UA:
   `... Chrome/124.0 Safari/537.36 HeadlessChrome/124.0.0.0`. `--headless=new` does **not** add this
   token. Detectors regex for `HeadlessChrome`. Spoofing the string in JS is necessary but not
   sufficient — `userAgentData` brand list also carries a `HeadlessChrome` brand that survives
   `--disable-blink-features`.
2. **`window.outerHeight`/`outerWidth`** — zero in old headless; real in new headless.
3. **`navigator.plugins`/`chrome.*`/codecs** — empty/missing in old headless, present in new.
4. **WebGL renderer** — `Google SwiftShader` in both unless a real GPU is forced.
5. **CDP side-effects** — the deeper surviving signal (see below).

### Running full Chrome headless to avoid the shell fingerprint

```js
// Puppeteer: headless:true uses headless=new on Chrome 109+. Pin it explicitly:
const browser = await puppeteer.launch({
  headless: 'new',                       // or Chrome 109+ default
  executablePath: '/path/to/real/Google Chrome',  // real Chrome, not bundled Chromium
  args: [
    '--headless=new',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--window-size=1920,1080',
    '--user-data-dir=/path/to/persistent/profile',
    // GPU: force a real renderer so WebGL/canvas pixels aren't SwiftShader
    '--use-gl=angle', '--use-angle=swiftshaderllvm', // or '-gl=d3d11'/'opengl'
  ]
});
```

### The surviving signal: CDP itself

Even with `--headless=new` and all JS patches, Puppeteer drives Chrome over the **Chrome DevTools
Protocol**. Detectors observe CDP side-effects from the page — runtime/serialization behaviors when
CDP domains are enabled, `Page.addScriptToEvaluateOnNewDocument` ordering, etc. — that no in-page
patch can reach. This is why:

- **Playwright** (lower-level CDP binding) leaves fewer obvious traces than raw Puppeteer in some
  checks, and **Patchright** (a Puppeteer fork that hides CDP artifacts) exists specifically here.
- **Managed cloud browsers** (Browserless, Scrapfly, etc.) decouple your code from the TLS/CDP
  session to the target.
- **OS-level input tools** (rare) avoid CDP entirely.

**Bottom line for an MCP:** use `headless:new` + real Chrome + `--disable-blink-features=
AutomationControlled` + a persistent profile + minimal, coherent JS patches. Treat the stealth
evasion bundle as a *baseline* (kills the value-level tells), and layer network (proxy/IP),
coherence (locale/timezone/UA/GL alignment), and behavioral realism on top. Against managed
challenges (Cloudflare Turnstile, DataDome, HUMAN), JS stealth alone is usually insufficient — the
TLS/HTTP/2 and CDP layers require infrastructure, not just code.

---

## Appendix A — Verification targets

Test your build against (all free, browser-based):
- `bot.sannysoft.com` — per-signal green/red (webdriver, plugins, Chrome detection…)
- `arh.antoinevastel.com/bots/areyouheadless` — dedicated headless detector
- `fingerprintjs.github.io/fingerprintjs/` — FingerprintJS visitorId stability
- `browserleaks.com/*` — canvas, webgl, audio, javascript, timezone surfaces
- `creepjs.abrahamjuliot.github.io` — "lie detection" (native `toString` checks, proxies)
- `tls.peet.ws/api/all` — reflect your JA3/JA4/akamai to compare against a reference build
- `paulirish/headless-cat-n-mouse` — the canonical detect-vs-evade harness (repo status: detectors
  winning)

## Appendix B — Canonical references

- `berstend/puppeteer-extra` — `puppeteer-extra-plugin-stealth/evasions/*` (primary source; each
  subfolder is one patch with inline notes).
- `fingerprintjs/fingerprintjs` — open-source fingerprinting library (the signals detectors use).
- `paulirish/headless-cat-n-mouse` — detect-vs-evade arms-race repo.
- Intoli, *It is not possible to detect and block Chrome headless* (2018) — original value-level tell
  catalog.
- Antoine Vastel (Castle/DataDome) — *New headless Chrome has a near-perfect fingerprint* (2023);
  *The role of WebGL renderer in browser fingerprinting*; *From Puppeteer stealth to nodriver*.
- Crawlex, *How puppeteer-extra-plugin-stealth works, patch by patch* (2026) — the injection model,
  `_utils` helpers, and per-evasion mechanics.
- Browserless — *TLS Fingerprinting: explanation, detection and bypassing in Playwright/Puppeteer*.
- Foil, Damru, Empirium, The Audit Veteran — JA3/JA4 and network-layer detection.
- `lwthiker/curl-impersonate`, `kubecfg/tls-client` — handshake/HTTP-2 impersonation clients.
- `HackingLZ/fingerprint_js` (VexTrio) — b-series checks incl. prototype-lie detection, deviceMemory
  valid-set, iframe webdriver leak.
- `managedcode/playwright_stealth` — ported evasion list (31 init-script patches).

---

*Prepared for legitimate automated-testing quality work. Stealth is an ongoing cat-and-mouse game;
validate against your target's actual detectors and keep fingerprints coherent rather than maximal.*
