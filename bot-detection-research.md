# Modern Bot Detection Systems — Technical Research Report

**Purpose:** Map exactly what signals modern detectors analyze, so a well-built Puppeteer/CDP browser automation runtime (headless-capable Chrome) can implement legitimate stealth. Scope is defensive/quality-testing: understand the adversary, not bypass CAPTCHAs.

**Bottom line up front:** A real Chromium binary + good residential IP + coherent multi-layer fingerprint (TLS/HTTP2/headers/JS/behavior) gets you surprisingly far. But *fingerprint and stealth JS patches alone are frequently insufficient* against Cloudflare/DataDome/Arkose — the dominant signals are **IP reputation** and **TLS/HTTP2 fingerprint consistency**, then **behavior**, then JS. See §7 for the honest reality.

---

## 1. Fingerprint.js (now "Fingerprint")

Fingerprint (fingerprint.com, formerly FingerprintJS) has three relevant products:

- **FingerprintJS library** (open source, GitHub `fingerprintjs/fingerprintjs`) — queries browser attributes and computes a hashed *visitor identifier*.
- **Fingerprint Pro / Pro Plus** (paid) — persistent `visitor_id` + 20+ **Smart Signals** (device/network intelligence), including **Bot Detection**.
- **Bot Detection API** + open-source **BotD** — classifies good/bad/not-detected bots.

### 1a. JS signals the library fingerprints

From the library's collectors and vendor docs, the attribute set includes both **passive** (cheap, always-available) and **active** (compute-expensive, higher entropy) signals:

| Category | Signals |
|---|---|
| Core identity | `userAgent`, `platform`, `oscpu`, `productSub`, `vendor`, `language(s)`, `languages` |
| Screen/display | `screenResolution`, `availableScreenResolution`, `devicePixelRatio` (`deviceDpi`), `colorDepth`, `touchSupport` (touch ID count), `maxTouchPoints` |
| Timezone/locale | `timezoneOffset`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Content-Languages` header |
| Hardware | `hardwareConcurrency` (CPU cores), `deviceMemory` (approx RAM), `cpuClass` |
| Rendering (active) | **Canvas** (2D draw → hash), **WebGL** (`UNMASKED_VENDOR/WebGL`, renderer, extensions, shader precision), **Audio** (`AudioContext`/`OfflineAudioContext` rendering differences) |
| Fonts | installed-font enumeration via measure-text (`document.fonts` / canvas metrics) |
| Storage | `localStorage`, `sessionStorage`, `indexedDB`, `cookies`, `WebRTC` local IP leak |
| Media/sensors | `navigator.mediaDevices.enumerateDevices()`, camera/mic count |
| Misc | `plugins`/`mimeTypes`, `doNotTrack`, `webgl`/`webgpu` capabilities, timing/precision (`performance.now`) |

The final visitor ID is a hash (Murmur3/SHA-256 family) of the concatenation of these signals. **Canvas, WebGL, and Audio carry the most stable, distinctive entropy** (vendor benchmarks); passive signals add breadth but are weak alone.

### 1b. Stealth / automation detection

Fingerprint's automation detection combines two mechanisms:

1. **BotD (open source, MIT)** — runs in-browser, scores signals into a confidence (0.1–0.9), classifies `isBot` at a 0.7 threshold. Three-tier weighting:
   - **Strong (0.3 each, can independently exceed threshold):** `navigator.webdriver === true`, `document.documentElement.getAttribute('webdriver')`, and framework globals — `window.Cypress`, `window.__nightmare`, `window._phantom`/`callPhantom`, Selenium eval hooks (`__webdriver_evaluate`, `__driver_evaluate`, `__selenium_unwrapped`), CDP globals (`domAutomation`, `domAutomationController`).
   - **Medium:** missing plugins, empty `navigator.languages`, contradictory permission states, small screen dimensions.
   - **Weak:** minor anomalies with high false-positive rates.
2. **Commercial Bot Detection (paid)** — a server-side API that ingests the JS-agent `event_id` **plus server-side auxiliary data** (TLS crypto support, IPv4/IPv6, network properties, browser overrides). Returns `bot: "good" | "bad" | "not_detected"` with `bot_type` (e.g., `headless_chrome`), `category` (`browser_automation`), `provider`, and `confidence`. It detects Selenium/Puppeteer/Playwright, headless Chrome/Firefox, **and stealth plugins** (`puppeteer-extra-plugin-stealth`, browserless, undetected-chromedriver, pyppeteer_stealth) and anti-detect browsers (AdsPower, Dolphin Anty, Kameleo). It also distinguishes *good* bots (search crawlers, authorized AI agents) from *bad* ones via **Web Bot Auth** cryptographic signing.

### 1c. Smart Signals / Suspect Score (paid)

Computed from the *same* device attributes, returned only server-side. Notable signals and example weights in **Suspect Score** (higher = riskier):

| Signal | Weight |
|---|---:|
| Virtual Machine Detection | 14 |
| IP Blocklist (`attackSource`) / `emailSpam` | 13–14 |
| Tor Exit Node | 14–17 |
| Data Center Proxy (`proxyType == data_center`) | 12–15 |
| Tampering (`AnomalyScore > 0.5`) / Anti-detect Browser | 8 |
| Developer Tools Detection | 8 |
| Bot Detection (`bot.type == bad`) | 7 |
| Privacy-Focused Settings | 6 |
| Residential Proxy | 6 |

`AnomalyScore` (0–1) is Fingerprint's "how improbable is this fingerprint per their statistical model" — the **Browser Tampering** signal. They also detect incognito, VPN (via `timezoneMismatch`, `publicVPN`, `osMismatch`, `relay`), Frida, MitM, rooted/jailbroken devices, and **velocity** (rapid distinct IPs/countries/events).

> **Key finding (server-side fingerprinting paper, UCSD WWW'26):** Fingerprint Pro sets two **first-party cookies** (`_vid_t`, `_iidt`, 1-year, `SameSite Lax/None`) plus two localStorage variables. **Persisting just those two cookies overrules *any* individual browser-attribute modification** — even a full fingerprint change (new OS/IP) returns the same VID (while still flagging "Browser Tampering"). Cookies + stable IP are the real tracking backbone; the JS fingerprint is secondary. This is exactly the "aggregated signals + first-party state" model §2 asks about.

---

## 2. Fingerprint Pro / Bot Identifier — how classification works

- **Visitor ID (identification):** persistent device/browser identity from the aggregated JS fingerprint above, *stable across browser updates, IP changes, and VPNs*. Robustness is prioritized over precision (hence tampering signals fire on coarse attribute changes but not fine-grained ones).
- **Bot Identifier / Bot Detection:** an additional Smart Signal layered on top. It uses the aggregated browser signals **combined with server-side network/data-layer context** (IP geolocation, datacenter/proxy/VPN classification, ASN, TLS crypto support, IPv4/IPv6).
- **What flags a bot:**
  - `navigator.webdriver`, framework/CDP globals (BotD strong signals).
  - Known automation tool fingerprints and **stealth-plugin side effects** (the commercial API specifically detects `puppeteer-extra-plugin-stealth` and anti-detect browsers).
  - **IP reputation:** datacenter proxy, `attackSource`/`emailSpam` blocklist, Tor, VPN.
  - **Anomaly Score:** a fingerprint too improbable/rare per their model → "Browser Tampering."
  - **Velocity:** many distinct IPs/countries/events in short windows.
  - `Content-Languages` header mismatch was empirically enough to trigger bot detection (they lean on static signals like webdriver).
- **Server-side advantage:** because the JS-agent data is verified server-side (they recommend validating `event_id` freshness, rejecting stale/fake tokens), client spoofing is harder. The paid tier's edge is **cross-referencing JS with network/cookie/IP state** — a single JS-layer pass is not predictive of the composite verdict.

---

## 3. Arkose Falcon (Arkose Bot Manager)

Arkose is the enterprise-grade, challenge-based leader (used by Microsoft, Roblox, Capcom, EA, etc.).

### 3a. How it works
- **Third-party token + device fingerprint.** Arkose injects a client-side JS SDK from its own origin (`js.rbxcdn.com`, etc.) that runs on the page, builds a fingerprint, and returns a **token** (`arkose_token` / challenge response) the origin validates server-side. Because it's a **separate third-party origin**, ad blockers and the site owner's own first-party scripts can't easily strip it — and there's no "collector" the user's own code controls.
- **225+ signals** collected, producing a risk score + risk band. Newer **Arkose Device ID** (sub-50ms) adds persistent device identification with AI-powered *similarity* analysis (not just static hashing) to survive browser updates/network changes, plus a historical identity record so evasion attempts produce a "detectable pattern," not a clean slate.

### 3b. Signals collected (from reverse-engineered Falcon docs + vendor docs)
- **WebGL:** extensions (`getSupportedExtensions()`), renderer/vendor, `WEBGL_debug_renderer_info`, hashed.
- **Canvas:** rendering hash (diminished by Google's canvas entropy reduction).
- **Fonts (JSF):** presence check across ~65 fonts via measure-text (e.g., Wingdings ⇒ Windows).
- **Screen/resolution:** real vs. "fake resolution" (`availWidth/availHeight` consistency → `FR`).
- **OS/browser consistency:** UA vs. `navigator.platform`/`oscpu` (`FOS` fake-OS); UA vs. `productSub`/behavior (`FB` fake-browser).
- **Plugins** (`P`), sensors (`c2d2015`: accelerometer/gyroscope availability), **web3** (e.g., MetaMask presence), touch, audio, timezone.
- **Evasion heuristics:** fake-OS/fake-browser/fake-resolution booleans, plugin iteration correctness.

### 3c. Why it's hard to bypass
1. **Third-party origin** — can't be blocked by the victim site's own CSP/ad-blocker config; loads from Arkose's CDN.
2. **Adversarial homogenization detection** — Arkose explicitly detects when many devices start looking identical (a stealth-fingerprint farm), because it keeps a **continuous cross-session identity record**.
3. **Adaptive challenges (MatchKey)** — when uncertain, serves interactive puzzles (image selection, etc.) that require human/cognitive solving; **CAPTCHA is reported, not bypassed** by this tooling.
4. **Device reputation** — links a fingerprint to historical fraud activity across Arkose's global customer network, so a "clean-looking" fingerprint on a bad-reputation device is still flagged.
5. **Multi-signal + behavioral** — mouse/keystroke dynamics + touch patterns combined with device fingerprint; uncertainty ⇒ challenge.

> **Takeaway for the MCP:** Arkose is a *challenge + reputation* system, not just a fingerprint. Stealth JS patches help the fingerprint portion but the challenge/reputation/device-reputation layers require a genuine human-like session (or a solving service) and a clean device/IP reputation.

---

## 4. Cloudflare (Bot Fight Mode / Super BFM / Turnstile / Universal Firewall / Bot Management)

Cloudflare layers multiple detection engines, each producing a **bot score 1–99** (1 = almost certainly bot, 99 = almost certainly human); operators write firewall rules against the score.

### 4a. Detection engines (from Cloudflare docs)
- **Heuristics engine** — processes *all* requests; matches against a growing database of known malicious fingerprints. Score 1 (high confidence) or 29 (assessing).
- **Machine Learning (ML) engine** — accounts for the *majority* of detections; leverages global network (billions of requests/day) to distinguish human vs. bot. Scores 2–99.
- **Anomaly Detection (AD)** — per-domain baseline; flags outliers (being deprecated in favor of future behavioral detections).
- **JavaScript Detections (JSD)** — lightweight, invisible client-side JS injection that identifies headless browsers and malicious fingerprints; blocks/challenges/passes. (Enabled by default on Bot Fight Mode.)
- **JA3/JA4 TLS fingerprints** (Enterprise Bot Management) — derived from the TLS ClientHello. **JA4 is the modern, stable signal** (sorts ciphers/extensions before hashing, survives Chrome 110+ per-connection extension randomization); JA3 retained for legacy/compat. Cloudflare also computes an **HTTP/2 fingerprint** and exposes aggregate **JA4 Signals** (browser ratio, known-bot ratio, request ranks, cache/error behavior across global traffic) — turning a fingerprint into a *reputation* feature.

### 4b. What they inspect (layer by layer)
- **TLS ClientHello:** version, cipher suites (+ order), extensions (+ order), supported groups, signature algorithms, SNI, ALPN → JA3/JA4.
- **HTTP/2:** frame/SETTINGS ordering (the Akamai-format components: SETTINGS, WINDOW_UPDATE, PRIORITY, pseudo-header order).
- **Headers/Client Hints:** header order, `sec-ch-ua`, `sec-ch-ua-platform`, UA version, `Accept-Language`, Fetch-Metadata; cross-checked against claimed browser.
- **Behavioral:** request timing/patterns, mouse movement (straight-line/teleport = bot; uniform timing = bot), scroll (smooth inertia = human; jumps = bot), dwell times, cookie handling, session multi-page behavior.
- **IP/ASN reputation:** residential-vs-cloud-provider patterns, per-customer anomaly baselines.
- **Browser fingerprint (JS):** `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `hardwareConcurrency`, `deviceMemory`, canvas/WebGL/audio, `performance.now` precision, missing APIs, **property descriptors / prototype chain** (overridden `navigator.webdriver` detectable via `Object.getOwnPropertyDescriptor`), **CDP artifacts** (`Runtime.enable` side effects — the single most reliable Puppeteer tell in 2026).
- **Turnstile:** CAPTCHA replacement; runs Managed/Non-Interactive/Invisible modes, issues `cf-turnstile-response` token; can accept **Apple Private Access Tokens** (device attestation).

### 4c. How "just passing" works
- **Bot Fight Mode / Super BFM:** free/included; pattern + heuristic + JSD challenge across the whole domain; cannot be bypassed via WAF rules (separate pipeline).
- **Bot Management (Enterprise):** granular per-request bot score + JA3/JA4 + HTTP/2 + behavioral + IP.
- **Passing requires:** a **real browser fingerprint** (so JS/CDP checks don't fire) **AND a good IP** (residential, not datacenter ASN) **AND coherent TLS/HTTP2/headers** **AND human-like behavior**. Cloudflare docs explicitly warn: *"Matching JA4 can be necessary for some flows, but it is not sufficient."* A stock client vs. browser-like client on the same proxy isolates whether the failure is TLS or IP/behavior.

---

## 5. DataDome, PerimeterX/HUMAN, Akamai Bot Guard, Imperva

### 5a. DataDome
- **Real-time ML** classifies every request (web, mobile, API) in **<2 ms** from **2000+ signals per request**: device fingerprint, behavioral patterns, HTTP headers, request sequencing, (residential) proxy/IP reputation, CAPTCHA-farm detection.
- **JS execution at first contact** — can detect/bot-flag at the *first* JavaScript execution and even **link a session specifically to `puppeteer-extra-plugin-stealth`** (DataDome flags ~40M such requests/week, tracing Bright Data/ScrapingBee/ScraperAPI BaaS providers). Detection via **advanced JS fingerprinting** (catches the *side effects* of how the plugin overrides built-ins — forged `PluginArray` iteration, property-descriptor anomalies), **advanced IP/session reputation**, and **behavioral detection**.
- Leaves browser traces: `datadome` cookie (base64 session-classification token), `x-datadome-request` response header, `ddCaptcha` global (present when challenged), tag from `tags.datadome.co`/`dd.js`, `DataDome` window global. Mobile SDK detects emulators/modified APKs/scripted behavior.

### 5b. PerimeterX / HUMAN (now HUMAN Security)
- **Dual approach:** passive server-side checks triggered by visitor requests **plus** active scripts on the visitor's agent.
- **Behavior-driven + ML**, combining behavioral data with **industry-wide threat intelligence** (collective/crowdsourced bot net data) to catch evasive botnets. HUMAN Bot Defender shields web/mobile/API.

### 5c. Akamai Bot Guard / Bot Manager
- **Edge bot defense** using a mix of **device fingerprint, behavioral analysis, and reputation**; strong on HTTP/2 fingerprinting (the "Akamai format" SETTINGS/PRIORITY ordering referenced by Cloudflare too).
- Leaves traces (HTTP response headers, injected cookies, third-party script URLs, `window` globals) — detectable via response-header/cookie/script-URL fingerprinting of the vendor.

### 5d. Imperva (Incapsula) Bot Management
- Combines **static, challenge-based, and behavior-based** approaches; matches each visitor to a **behavioral ID**. Classifies human vs. bot via **behavioral analysis + device fingerprinting + intent modeling**. API protection inspects request patterns for credential stuffing.

### 5e. Common thread
Every major vendor leaves an **invisible fingerprint** (headers, cookies, third-party script origins, `window` globals) and layers **TLS/HTTP2 + JS fingerprint + behavioral + IP reputation + ML/collective intelligence**. The "collective intelligence" angle (DataDome, HUMAN, Cloudflare) means a clean-looking session from a bad-reputation IP or an overused residential pool is still flagged.

---

## 6. Common evasion signals to implement (legitimate automation)

> Goal: make a Puppeteer/CDP session indistinguishable from a real user *at every observable layer*, for legitimate automated testing.

### 6a. Consistent, real-browser fingerprint (avoid headless shell)
- Use **headed Chrome** or Chrome's **`--headless=new`** (new headless, Jan 2023+) which runs the *same binary* as headed Chrome: populated `navigator.plugins`/`mimeTypes`, real `chrome.runtime`, hardware WebGL renderer, no `HeadlessChrome` UA token.
- **Launch flags:** `--disable-blink-features=AutomationControlled` (suppresses `navigator.webdriver` flag at source), realistic `--window-size` (avoid default 800×600), `--lang`/`Accept-Language` matching locale.
- **JS-layer patches** (last resort, applied via `evaluateOnNewDocument`): delete `navigator.webdriver` (not set to `false` — a tampered descriptor is itself a tell), synthesize `window.chrome` (`app`, `csi`, `loadTimes`, `runtime`), realistic `navigator.plugins`/`languages`/`vendor`, `navigator.hardwareConcurrency`/`deviceMemory`, media codec support, `navigator.permissions` (notifications state must match `Notification.permission`), `window.outerDimensions`.
- **Avoid the classic tells:** empty plugin list, empty `navigator.languages`, `Notification.permission === 'denied'` on a Chrome UA, `SwiftShader`/`llvmpipe` software WebGL renderer, `HeadlessChrome` in UA, timezone mismatching IP geolocation.

### 6b. Matching TLS/HTTP2 fingerprint (the hard part)
- **Why it's hard in pure Puppeteer:** when Puppeteer drives a *real* Chromium binary, the TLS handshake is performed by **Chromium's BoringSSL** — so the JA3/JA4 is *already* real Chrome's. **There is no TLS leak at the pure-Puppeteer layer.** The leak is at the **CDP layer** (`Runtime.enable` side effects) and JS layer.
- **The real TLS risk appears when a MITM/proxy terminates and re-originates TLS** with a non-browser library (Node `https`, Go, Python OpenSSL) — then the ClientHello diverges from Chrome. Also, **custom Chrome flags / unusual builds** can perturb the handshake.
- **Consistency is the invariant:** TLS (Chrome) ⇒ HTTP/2 (Chrome SETTINGS/PRIORITY) ⇒ header order + `sec-ch-ua` (JA4H) ⇒ UA version ⇒ supported groups. Chrome ships new ClientHello fields per release (PQ key shares, ECH, Brotli/ZSTD); a pinned/stale profile looks like an old browser. A real browser holds this coherence *for free*; an impersonation stack must maintain it *by discipline*.
- **Practical guidance:** prefer a real browser (TLS correct for free); if a proxy/MITM re-originates TLS, ensure it uses a browser-accurate profile (BoringSSL-based) and keep TLS/HTTP2/headers in lockstep with the same Chrome version.

### 6c. IP reputation (#1 factor)
- **The single most decisive signal.** Cloudflare/Akamai/DataDome maintain ASN databases of AWS/GCP/Azure/OVH/Hetzner etc. **A perfect Chrome JA4 from a datacenter IP is still flagged** — real users don't browse from datacenter ASNs.
- **Residential proxies** (ISP-assigned household IPs, geolocation matching the set timezone/locale) are effectively mandatory for strong detectors. Overused residential pools and datacenter exits fail even with clean fingerprints (collective-intelligence flagging).
- **Alignment:** IP geolocation ↔ timezone ↔ `Accept-Language` ↔ `sec-ch-ua-platform` must all agree. A Comcast-Seattle IP with a Chrome JA4 and matching HTTP/2 passes; a mismatch is an instant tell.

### 6d. Behavioral signals
- **Mouse:** natural bezier curves, varying velocities, dwell times — not straight lines or teleport jumps; not perfectly uniform timing.
- **Typing:** variable inter-key timing, human cadence.
- **Scroll:** smooth with inertia, varied speed, human-like pauses; not instant jumps or constant-rate scrolling.
- **Request patterns:** varied dwell times across pages, human-like rate with jitter (no 100 pages/min uniform timing).
- These feed ML behavioral models (Cloudflare, DataDome, HUMAN). Bots that "pass fingerprint but never move" are caught here.

### 6e. Proper headers
- `Accept-Language` and `Content-Languages` matching the chosen locale/UA.
- **User-Agent Client Hints:** `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `sec-ch-ua-Full-Version-List` — must be **consistent with the UA string** and with `navigator.userAgentData.getHighEntropyValues(...)`. Missing CHs, or CHs that disagree with the UA, is a tell.
- Consistent header **order** and `Accept`/`Accept-Encoding` (gzip, br, zstd) matching a real Chrome.
- Proper cookie handling (real browsers persist/return cookies per domain; don't strip or mishandle).

---

## 7. The reality — honest limitations

1. **Fingerprint/stealth JS patches are necessary but not sufficient.** `puppeteer-extra-plugin-stealth` "passes all public bot tests" (its authors' own claim) — but those are *public* compatibility sites, not Cloudflare/DataDome/Arkose. DataDome explicitly detects the stealth plugin via override side-effects; Cloudflare's JSD + CDP `Runtime.enable` detection and ML beat whack-a-mole patches.
2. **The dominant signals are below the JS layer:** **IP reputation** (datacenter vs residential) and **TLS/HTTP2 fingerprint consistency**. A pure-JS stealth approach ignores the two layers that modern detectors weight most. As one analysis put it: *"A perfect ClientHello is necessary and nowhere near sufficient."*
3. **CDP is the bind for Puppeteer.** Puppeteer is "CDP all the way down." `Runtime.enable` leaves an observable side-effect (the most reliable Puppeteer tell in 2026). Stealth patches can't change *how Puppeteer talks to CDP*. Workarounds (avoid `Runtime.enable`, use CDP-minimal drivers like `nodriver`/Rebrowser) defeat the *specific* check but introduce their own artifacts and lose feature completeness.
4. **The "seam" problem:** detection lives in the *disagreement between layers* — TLS says Chrome, HTTP/2 says Go/Python, headers disagree with the UA, behavior is robotic. You must make **all layers coherent at one Chrome version simultaneously**, which is "most of the way to just running the browser." Version drift (Chrome releases every few weeks) makes static impersonation stacks decay on schedule.
5. **Collective intelligence compounds IP risk:** DataDome/HUMAN/Cloudflare share bot intelligence across clients, so an overused residential pool or a bad-reputation ASN is flagged even with a perfect fingerprint.
6. **Challenges (Arkose MatchKey, Cloudflare Turnstile, DataDome `dd`) require human-solving** — this tooling reports CAPTCHAs but does not bypass them.
7. **What's achievable:**
   - **Against heuristic/JSD + weak targets:** a well-built headless-capable Chrome (headed or `--headless=new`) + stealth flags + good headers + residential IP → high pass rate.
   - **Against Cloudflare Bot Management / DataDome:** real Chromium + residential IP (geolocation-aligned) + coherent TLS/HTTP2/headers + human-like behavior → often passes; the IP layer is usually the deciding factor.
   - **Against Arkose (enterprise, challenge-based):** hardest — needs genuine human-like session + clean device/IP reputation + challenge solving; stealth alone rarely suffices.
8. **Legitimacy note:** This is for automated *testing quality* — consistent, coherent browser identity, proper headers, realistic behavior. CAPTCHA/anti-bot challenges are reported, not circumvented. DNS/preflight checks are policy gates, not firewalls.

---

## Sources

- **Fingerprint / FingerprintJS:** docs.fingerprint.com (Bot Detection Overview, Smart Signals, Suspect Score, Server API, Automation Intelligence API); GitHub `fingerprintjs/BotD` (MIT, open-source in-browser detector); GitHub `fingerprintjs/fingerprintjs` (library). Server-side fingerprinting analysis: UCSD *Understanding Server-side Commercial Fingerprinting* (WWW'26) — `_vid_t`/`_iidt` cookie re-identification, IP/cookie supervision.
- **Cloudflare:** developers.cloudflare.com/bots (Bot Detection Engines, Bot Fight Mode, Super Bot Fight Mode, JSD); Cloudflare Bot Management reference architecture; JA3/JA4 coverage (krowdev, mobileproxies, hidettp, usefoil).
- **Arkose:** arkoselabs.com (Arkose Bot Manager "225+ signals", Arkose Device ID, "Fingerprinting Is Broken"); azureflow.github.io/arkose-fp-docs (reverse-engineered Falcon signals: `enhanced_fp`, JSF fonts, FR/FOS/FB heuristics); Security Boulevard device-id writeup.
- **DataDome:** datadome.co threat research — "Detecting Headless Chrome's Puppeteer Extra Stealth Plugin" (Vastel); DataDome bot-protection/product docs.
- **PerimeterX/HUMAN, Akamai, Imperva:** akamai.com/products/bot-manager; imperva.com/learn/.../what-are-bots; clearout.com & indusface.com vendor comparisons; medium "hidden fingerprints of bot protection" (vendor trace signatures).
- **TLS/HTTP2 (JA3/JA4):** salesforce/ja3, FoxIO/ja4; browserless.io TLS fingerprinting guide; crawlex.net "second-order tells" (TLS vs HTTP/2 seam); BotCloud, ProxyHat, Serpent API JA4 measurements; curl_cffi/curl-impersonate FAQ.
- **Stealth/automation artifacts:** berstend/puppeteer-extra-plugin-stealth (evasion list); online/headless-detector (15+ vectors, Castle/DataDome/FingerprintJS-derived); Foil "How Foil detects Puppeteer" (CDP `Runtime.enable`); BotCloud "navigator.webdriver 7-signal teardown."

*Report compiled from vendor docs and independent research as of Aug 2026. Detector internals evolve rapidly; treat closed-vendor claims (Cloudflare/DataDome/Arkose/Fingerprint) as best-known, since exact weights and checks are proprietary.*
