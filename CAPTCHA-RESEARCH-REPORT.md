# CAPTCHA Systems & Browser-Automation Handling — Technical Research Report

> Prepared for the Smooth-Operator MCP server (Puppeteer/CDP). Scope: the technical
> reality of CAPTCHA providers, how they detect bots, and the responsible options for
> handling challenges in an authorized automation context. This is a technical survey,
> not a bypass guide — the focus is on detection signals, API contracts, latency,
> accuracy, and the hard limits of each approach.

**Bottom line:** Modern CAPTCHA is a *risk engine*, not an image puzzle. The visible
widget is the exception; the decision is made before the puzzle renders, from IP
reputation, TLS/browser fingerprint, and behavioral signals. "Solving" a challenge is
only ever the last step of a much larger trust story. For a Puppeteer/CDP server this
means: detection is cheap and reliable, explicit solving works on a shrinking set of
challenges, and the durable win is *prevention* (clean IP + real-browser fingerprint +
human pacing) with solvers/HITL as a bounded fallback.

---

## 1. CAPTCHA Landscape

All major providers share the same shape: a client-side script collects signals, a
token is minted, the site posts the token to a vendor `siteverify`/Verify API, and the
vendor returns a verdict. The differences are the widget class, the response field, the
script domain, and how the challenge is decided.

### 1.1 Google reCAPTCHA

reCAPTCHA v1 (human-assisted OCR / image identification) was shut down **March 31, 2018**
and is dead. It is retained here only for historical completeness. Detection: legacy
`g-recaptcha` with image tiles; validation was the original `siteverify`. It no longer
exists in the wild. *(Google changelog; Wikipedia "reCAPTCHA v1".)*

**reCAPTCHA v2 (checkbox + image grid).**
- **Detection signals:** script `https://www.google.com/recaptcha/api.js`; widget
  container `<div class="g-recaptcha" data-sitekey="6Le-…">`; `data-size="invisible"`
  marks the invisible variant. In the browser, `grecaptcha` is exposed on `window`.
- **Validation:** on success the SDK writes a token to a hidden field named
  `g-recaptcha-response`; the site POSTs it to
  `https://www.google.com/recaptcha/api/siteverify` with the secret key. Response JSON:
  `{ success, score?, action?, challenge_ts, hostname, error-codes }`. Token validity
  ~120s, single-use. *(Google developers docs.)*
- **Failure modes:** wrong `sitekey`/`secret` pairing → `sitekey-secret-mismatch`;
  expired/duplicate token → `expired-input-response` / duplicate-token failure;
  `TOO_MCH_TRAFFIC` / `UNEXPECTED_USAGE_PATTERNS` when traffic volume diverges from the
  site's baseline. The image grid is a fallback, not the decision — the risk engine
  decides before the grid renders.

**reCAPTCHA v3 (score-based, no UI).**
- **Detection signals:** `https://www.google.com/recaptcha/api.js?render=SITEKEY`
  (score-based script) or `grecaptcha.execute('SITEKEY', {action})`. No visible widget;
  the reCAPTCHA *badge* may still appear bottom-right. `grecaptcha.enterprise` is
  `undefined` for standard keys.
- **Validation:** `execute()` returns an action-bound token; the site POSTs it to the
  same `siteverify`. Response adds `score` (0.0–1.0, **1.0 = likely human, 0.0 = bot**)
  and `action`. The site **must** verify the `action` matches (else a token minted on a
  low-stakes page is replayed against a high-stakes one). Tokens expire 2 minutes.
- **Failure modes:** a fresh proxy with no browsing history scores ~0.1 even with a
  "valid" token; mismatched `action` → `action-mismatch`; score below the site's
  threshold is an allow/block decision the site makes server-side. *(Google reCAPTCHA v3 docs.)*

**reCAPTCHA Enterprise.**
- **Detection signals:** `https://www.google.com/recaptcha/enterprise.js` (vs `api.js`);
  `grecaptcha.enterprise` exists. Same `g-recaptcha`/`g-recaptcha-response` surface.
- **Validation:** assessment model. Client calls `grecaptcha.enterprise.execute()` to
  mint a token; the backend calls the `projects.assessments.create` API
  (`https://recaptchaenterprise.googleapis.com/v1/{project}/assessments`) with
  `{ event: { token, siteKey, userAgent, userIpAddress, ja3, ja4, expectedAction } }`.
  Returns `tokenProperties.valid`, `tokenProperties.action`, and a `riskAnalysis`
  (`score`, `reasons[]`). The API explicitly accepts **JA3 and JA4 TLS fingerprints** as
  first-class inputs. *(Google Cloud "Create assessments" docs.)*
- **Failure modes:** `invalidReason` on token (`EXPIRED`, `MISSING`, `INVALID_ACTION`,
  etc.); `CLASSIFICATION_REASON` reasons like `DATA_CENTER_IP`, `MOBILE_DEVICE`,
  `SUSPECTED_BOT`; score buckets (the free tier's "score" is coarse).

### 1.2 hCaptcha (Intuition Machines)

- **Detection signals:** script `https://js.hcaptcha.com/1/api.js` (also
  `https://hcaptcha.com/1/api.js`); widget `<div class="h-captcha" data-sitekey="UUID">`;
  iframe sources `newassets.hcaptcha.com` / `imgs.hcaptcha.com`. Sitekey is a
  **UUID** (`10000000-ffff-…`), distinct from reCAPTCHA's `6L…` base64 keys.
- **Validation:** token written to `h-captcha-response`; site POSTs
  `secret` + `response` (+ optional `remoteip`, `sitekey`) as `application/x-www-form-urlencoded`
  to `https://api.hcaptcha.com/siteverify` (POST, not GET). Response: `{ success, challenge_ts, hostname, error-codes }`.
  Token ~120s, single-use; reuse → `already-seen-response`.
- **Key differences / traps:**
  - **Inverted score polarity in Enterprise.** hCaptcha Enterprise's `score` is a
    **risk** score: **1.0 = confirmed threat, 0.0 = no risk** — the exact opposite of
    reCAPTCHA. Porting a "block if score < 0.5" rule flips the whole policy.
    *(crawlex.net technical comparison.)*
  - **`rqdata`** (Enterprise/BotStop): a signed, session/action-bound payload passed
    through to bind the challenge; internal layout not public, inferred from traffic.
  - **`hsw` proof-of-work:** a hashcash-style WASM search the client must solve before
    hCaptcha accepts the submission; difficulty (required bits) scales per request,
    compounding the cost for high-volume automation.
  - **Blind tokens** (since 2022): hCaptcha can sign a passcode it cannot read, letting a
    device attest hardware properties without being named — a privacy-preserving pass.
- **Failure modes:** `expired-input-response`, `already-seen-response`,
  `sitekey-secret-mismatch`, `not-using-dummy-passcode`. Enterprise score threshold
  higher than free.

### 1.3 Cloudflare Turnstile

- **Detection signals:** script `https://challenges.cloudflare.com/turnstile/v0/api.js`;
  container `<div class="cf-turnstile" data-sitekey="0x4…">` (sitekeys start with
  `0x4`); hidden field `cf-turnstile-response`. Can be embedded via HTML, a
  `turnstile.render()` JS call, or dynamically after an XHR/action.
- **Validation:** runs small non-interactive JS challenges (proof-of-work,
  proof-of-space, API probing, browser-quirk/human-behavior checks) in the background;
  on success writes `cf-turnstile-response`; the site calls Cloudflare `siteverify`.
  **Three modes:** *Managed* (shows a small widget/click, usually auto-completes),
  *Non-interactive* (silent, still mints a signed token), *Invisible* (no widget at all).
  Token ~5 min, single-use. *(Cloudflare Turnstile docs.)*
- **Failure modes:** stale/wrong sitekey; `data-action` required when the site checks it;
  token injected but submit button stays disabled → the site relies on the
  `onSuccess` callback and the callback must be re-fired after injection. **Important
  distinction:** Turnstile (widget → token) is *not* the Cloudflare **Challenge page**
  (full-page interstitial → `cf_clearance` cookie, IP-bound, 30-min lifetime). A
  `cf-turnstile-response` token cannot clear a Challenge page.
- **OpenAI / ChatGPT context:** ChatGPT uses Cloudflare Turnstile plus a "Sentinel"
  challenge that, per reverse-engineering (Buchodi), inspects application-state markers
  (a real React boot path) in addition to browser signals. This is the frontier:
  anti-bot logic moving *into* application execution, so "runtime completeness" is
  becoming a first-class trust signal. *(penligent.ai analysis; GigAZINE.)*

### 1.4 Geetest

- **Detection signals:** script from `gt4-…`/`geetest…` CDNs; widget exposes `gt`,
  `challenge` (v3) or a `captchaId` (v4).
- **v3 validation:** the client posts `gt` + `challenge` to Geetest's `/gc_v4` endpoint
  and receives **three tokens**: `challenge`, `validate`, `seccode`, which the form
  submits. Challenge types: slider puzzle, click-order, icon matching.
- **v4 validation:** a `captchaId` (opaque, per-session) plus a **deobfuscated, signed
  payload**. Solvers reverse Geetest's obfuscated JS (AES-CBC/RSA-PKCS1v1.5 + a `W`
  signature + proof-of-work) to produce `pass_token`, `lot_number`, `captcha_output`,
  `gen_time`. v4 is "adaptive": difficulty scales with observed behavior.
- **Failure modes:** v3 tokens must be submitted together and are short-lived; v4
  requires live JS execution to deobfuscate (a `requests`-only client can't produce a
  token at all), and the signature/`W` param rotates, so static clients fall behind.
  *(Geetest docs; CapSolver/2Captcha Geetest guides.)*

### 1.5 Arkose Funcaptcha / Arkose Falcon (now "Arkose MatchKey")

- **Detection signals:** script `https://client-api.arkoselabs.com/{customer}/v2/{pubkey}/api.js`;
  widget uses **`data-pkey`** (public key), **not** `data-sitekey` — a common confusion.
  Challenge renders in an iframe on `arkoselabs.com` / `funcaptcha.com`.
- **Validation flow:**
  1. Client collects a dense browser fingerprint into an encrypted payload (`bda`,
     "browser data").
  2. `POST /fc/gt2/public_key/` (setup) ships `bda` + site URL + public key; the
     response decides **transparent** (no game, `suppressed:true`), a proof-of-work, a
     visual challenge, or `pow+visual` — the `challenge_type` records where on the
     ladder the session landed.
  3. `POST /fc/gfct/` fetches challenge data (`session_token`, `challengeID`,
     `challengeURL`, `dapib_url`).
  4. `onCompleted` fires with a **single-use token**; the site posts it server-side to
     the **Verify API (v4)** with a private key → verdict `{ solved, transparent,
     difficulty_level, risk scores, telltales }`.
- **Why the token is special:** single-use, server-validated only, and **session-bound**
  via the `dapib` proof-of-work. A solved token cannot be replayed or farmed; a token
  solved on a different IP/fingerprint than the submitting session can still verify
  poorly.
- **Failure modes / difficulty:** difficulty is an *output of the risk engine*, not a
  fixed widget property — a headless/flagged session gets a multi-round gauntlet or a
  brutal per-session proof-of-work (Low/Medium/High/Extreme, **device-adaptive**).
  ~1,250+ puzzle variants; Microsoft deployments also require the encrypted **`blob`**
  data. Token is ~2KB. Injection target is `fc-token` / `verification-token` (+ callback).
  *(crawlex.net FunCaptcha internals + token-flow; Arkose Labs "Challenge is a sensor".)*

### 1.6 FriendlyCaptcha

- **Detection signals:** script `site.min.js`; widget `<div class="frc-captcha"
  data-sitekey="FC…">` (alphanumeric, not UUID/base64); hidden field defaults to
  `frc-captcha-solution` (renamable via `data-solution-field-name`).
- **Validation:** **proof-of-work** — the device solves a unique crypto puzzle in the
  background (a few seconds); on success the solution lands in the hidden field. Site
  POSTs to `https://api.friendlycaptcha.com/api/v1/siteverify` with `solution` (+
  optional `sitekey`). v2 adds `risk_intelligence` / `ip_intelligence` /
  `anonymization_detection`.
- **Failure modes:** `ERROR_WRONG_SITEKEY` (stale sitekey), puzzle endpoint geofencing
  (EU vs global). It actively detects `WebDriver`, headless, TLS-signature anomalies,
  VPN, and "autonomous AI agent" signatures.
- **Note:** because it's pure proof-of-work with a verifiable solution, FriendlyCaptcha
  is one of the more "solvable" widgets — but its risk layer still flags automation.

### 1.7 OpenAI "Enterprise Turnstile"

Not a separate product — OpenAI deploys Cloudflare **Turnstile** (plus the Sentinel
challenge noted above). Detection is the Turnstile signal set plus, in ChatGPT's case,
application-boot-state checks. Solvers that return a `cf-turnstile-response` token face
the same Turnstile constraints, plus the added requirement that the browser reach a
"complete" app runtime.

### Quick reference table

| Provider | Widget class / script | Response field | Verify endpoint | Sitekey format | Challenge model |
|---|---|---|---|---|---|
| reCAPTCHA v2 | `g-recaptcha` / `google.com/recaptcha/api.js` | `g-recaptcha-response` | `google.com/recaptcha/api/siteverify` (GET) | `6L…` | checkbox/grid, risk-first |
| reCAPTCHA v3 | `api.js?render=` / `grecaptcha.execute` | `g-recaptcha-response` (+action) | same `siteverify` | `6L…` | invisible, score 0–1 (high=human) |
| reCAPTCHA Enterprise | `recaptcha/enterprise.js` | `g-recaptcha-response` | `projects.assessments.create` (JA3/JA4) | `6L…` | assessment, risk reasons |
| hCaptcha | `h-captcha` / `js.hcaptcha.com/1/api.js` | `h-captcha-response` | `api.hcaptcha.com/siteverify` (POST) | UUID | grid/hidden, **risk score inverted** |
| Cloudflare Turnstile | `cf-turnstile` / `challenges.cloudflare.com/turnstile/v0/api.js` | `cf-turnstile-response` | Cloudflare `siteverify` | `0x4…` | managed/non-interactive/invisible |
| Geetest v3 | `gt`/`challenge` | `challenge`+`validate`+`seccode` | Geetest `/gc_v4` | — | slider/click/icon |
| Geetest v4 | `captchaId` | `pass_token`/`lot_number`/`captcha_output` | Geetest (signed) | opaque id | adaptive |
| Arkose FunCaptcha | `data-pkey` / `client-api.arkoselabs.com` | `fc-token`/callback | Arkose Verify API v4 | public key | single-use, session-bound, PoW |
| FriendlyCaptcha | `frc-captcha` / `site.min.js` | `frc-captcha-solution` | `api.friendlycaptcha.com/api/v1/siteverify` | `FC…` | proof-of-work |

---

## 2. How Detectors Know It's a Bot

CAPTCHA is the *visible tip*. The trust score is computed from many layers, and a
solver only addresses the last one.

### 2.1 Network / IP layer
- **Datacenter IP reputation:** AWS/GCP/Azure/hosting ranges are catalogued and start
  every request with a strike. Reported reCAPTCHA v3 averages: datacenter-shared
  ~0.1–0.2 (95%+ trigger rate), static residential ~0.6–0.8, mobile 4G/5G ~0.7–0.9
  (2–10% trigger). *(xProxy Market.)*
- **ASN / proxy detection:** shared block lists; if a rotation pool's IPs all fall in one
  ASN, rotation is invisible to the detector.
- **IP-token binding:** the IP that *solved* the CAPTCHA must match the IP that
  *submits* the token, or the token is rejected. This is why `cf_clearance` and Arkose
  tokens are IP-bound and why solvers accept a `proxy` parameter.

### 2.2 TLS / HTTP fingerprint layer
- **JA3 / JA4:** MD5/structured hashes of the TLS `ClientHello` (ciphers, extensions,
  curves, order). Chrome 108+ randomizes extension order, which broke JA3; **JA4**
  (FoxIO) sorts before hashing and is now the standard — **Cloudflare exposes JA3/JA4 to
  Enterprise Bot Management**, Akamai computes it at the edge, DataDome feeds it to ML.
  *(Salesforce JA3; FoxIO JA4; Cloudflare/DataDome docs.)*
- A Chrome UA over a Python/Go TLS stack (OpenSSL/`net/http`) is itself a bot tell — the
  handshake must *agree* with the declared device. Fix it with `curl-impersonate` /
  `curl_cffi` / Go `utls`. A proxy does **not** change JA3/JA4 — only the client library does.
- **HTTP/2 fingerprint:** frame order, header order/settings.

### 2.3 Browser environment layer
- **`navigator.webdriver === true`** (W3C-specified, announced only under automation).
- **`HeadlessChrome`** substring in `navigator.userAgent`.
- **CDP detection:** Puppeteer/Playwright serialize CDP messages with side effects;
  e.g. `Object.defineProperty(Error, 'stack', {get(){…}})` logs under CDP but not a real
  browser. `--disable-blink-features=AutomationControlled` hides `webdriver` but not CDP.
- **Playwright globals:** `__playwright__binding__`, `__pwInitScripts`.
- **Canvas / WebGL / AudioContext** fingerprints; screen, font list, plugin set;
  **UA ↔ platform consistency**.
- New Headless Chrome (same codebase as headful) nearly matches a real fingerprint, so
  environment checks alone are no longer sufficient — vendors correlate across layers.
  *(Castle/Security Boulevard; DataDome threat research.)*

### 2.4 Behavioral layer
- Mouse trajectory, timing rhythm, page-interaction naturalness, solve speed per round,
  answer patterns (did it visually process options?), failure signatures, micro-timing
  regularity. Arkose explicitly collects these and feeds them back into the model —
  "a bot that passes still reveals itself in the way it passes."

### 2.5 The "everything must agree" principle
Detection is a composite score. A perfect browser handshake from a flagged datacenter IP
still fails on IP reputation; a pristine mobile IP with a Python fingerprint still fails
on TLS. Every layer has to agree. This is the single most important design constraint for
any solver/solver-service target.

---

## 3. Human-in-the-Loop Solving (the "ask the user" pattern)

**Pattern:** the autonomous run proceeds until it hits a wall it can't complete, then
**pauses, surfaces the challenge to a human, and resumes** mid-task on the same live
session — no restart, clean state. This is the dominant 2026 pattern for AI agents
(BrowserBash, Browserbase's `askHuman`, Cloudflare Browser Run HITL mode;
`captcha-relay` relays the visible widget to a phone via Telegram and injects the token
back via CDP).

**How it works for a Puppeteer/CDP server:**
1. Detect the challenge (widget class + sitekey) via a fresh snapshot.
2. Keep the **headed** browser alive; surface the challenge (local overlay, or relay
   link to a device).
3. Human solves the visible challenge in the real browser.
4. Agent re-reads the page, sees it cleared, and continues.

**Pros:**
- **Highest reliability** on the hardest challenges (Arkose, behavioral v3, Turnstile
  Sentinel) — a real human + real browser defeats what no solver reliably beats.
- **No per-solve cost**, no third-party API keys, no IP-solve mismatch.
- Verifies the security wall actually works (useful for QA/security research).
- Token injection is trivial because the token is minted in the very session that submits.

**Cons:**
- **Latency:** seconds to minutes per challenge; throughput is human-bound.
- **Not unattended** — unsuitable for CI/bulk; must split suites (interactive HITL for
  real walls, automated for controlled/staged flows).
- **Complexity:** needs a generous timeout, an interruption seam, and a "fail loudly if
  the seam is unfilled" exit code so unattended runs don't hang silently.

**Verdict:** the right default for authorized, low-volume, high-value flows and for the
challenges that resist automation (Arkose, behavioral). The MCP server's `browser_*`
tools already keep a headed private browser — HITL fits naturally behind the gated
`browser_wait_for_human`-style seam.

---

## 4. Third-Party Solver Services

**Industry shape:** two families — (a) **token-based API services** (submit
`sitekey`/`pageurl`/`proxy` → poll → inject token) and (b) **browser-extension / SDK
agents** (NopeCHA, CapSkip) that run in-process. Most combine AI inference with a human
fallback.

### 4.1 The API-contract pattern (uniform across providers)
1. **Detect** the widget; extract `sitekey` (or `pkey`/`captchaId`/`gt`+`challenge`) +
   `pageurl` (must include the path, not just the origin).
2. **Submit** a task with the provider's `method`/`type` + `sitekey`/`googlekey`/
   `websiteKey` + `pageurl` + optional `proxy`/`proxytype`.
3. **Poll** for the result (or use a blocking `?wait=` param / callback webhook).
4. **Inject** the returned token into the correct hidden field and, where the site
   relies on a JS callback, re-fire the callback.

**Common parameters:** `key`/`clientKey` (API key), `method`/`type`, `sitekey`/
`googlekey`/`websiteKey`, `pageurl`, `proxy` (+`proxytype`), `min_score` (v3), `action`,
`data`/`cData` (Arkose blob / Cloudflare page data), `userAgent`.

### 4.2 Provider comparison

| Service | Model | Solve style | Coverage | Speed | Cost (1k) | Notes |
|---|---|---|---|---|---|---|
| **2Captcha** | Human + AI | `in.php` submit → `res.php` poll | reCAPTCHA v2/v3/Enterprise, hCaptcha, Turnstile, Arkose, GeeTest, grid, image | 15–30s | ~$1.5–3 | Broadest coverage, human fallback for novel formats |
| **Anti-Captcha** | Human + AI | `createTask`/`getTaskResult` | reCAPTCHA, hCaptcha, FriendlyCaptcha, Amazon WAF, Altcha | 10–25s | ~$1–2 | v3 proxy solving weaker (failed in one benchmark) |
| **CapSolver** | AI-only | `createTask`/`getTaskResult` | reCAPTCHA v2/v3, hCaptcha, Turnstile, FunCaptcha, GeeTest, DataDome, AWS WAF | 1–8s | $0.8–1.5 | Fastest/cheapest; lower accuracy on hardest enterprise cases |
| **DeathByCaptcha** | Hybrid | HTTP (`api.dbcapi.me`) or socket (8123–8130) | Image, reCAPTCHA v2/v3/Enterprise, hCaptcha, FunCaptcha, Turnstile, GeeTest | 8–27s | ~$1.39–2.39 | Most API-stable (17+ yrs); weak v3 scores + FunCaptcha |
| **NopeCHA** | Extension/SDK | in-process, one `POST /v1/solves?wait=90` | reCAPTCHA, hCaptcha, MTCaptcha | 5–15s | ~$1–1.5 | Free 100/day no key; browser-extension approach |
| **NoneCap** | AI | `POST /v1/solves?wait=90` | **hCaptcha only** (regular/invisible/enterprise `rqdata`) | — | $0.20–0.50 | Only solver reliably returning enterprise `rqdata` tokens |

**Accuracy / latency (representative benchmarks):**
- reCAPTCHA v2: ~95% success, 8–14s, ~$1/1k (highest solver success rate of any type).
- hCaptcha: ~95–98%, 12–20s, ~$1.5/1k; harder image set than reCAPTCHA.
- reCAPTCHA v3: **all solvers returned valid tokens but a uniform 0.10 score** in one
  2026 benchmark — validity ≠ quality. Speed: CapSolver 3.4s vs 2Captcha 36s. Cost ~$1–3/1k.
- Turnstile: ~91–98% depending on provider, 5–8s, ~$0.8–2/1k.
- FunCaptcha: ~88%, slowest (15–30s, sequenced 2–3 sub-challenges), 2–3× the price.
- **IP dependency:** one provider's paired test on a Turnstile target went **41%
  (datacenter) → 88% (residential)** with no other change. The IP, not the solver, was
  the variable.

### 4.3 Headless / datacenter restrictions
Many solvers now **refuse or degrade** on datacenter/free traffic: Anti-Captcha returns
`ERROR_TASK_NOT_SUPPORTED` for proxy-based v3 in some cases; Cloudflare Challenge tasks
are **proxyless-disabled** (return `ERROR_PROXY_REQUIRED`) because `cf_clearance` is
IP-bound; Turnstile/v3 success collapses on datacenter IPs. The practical rule: pass the
**same residential/sticky proxy** to the solver that loads the page, and pin it across
the solve→submit cycle.

### 4.4 Token injection (field-by-field)
- reCAPTCHA v2/v3 → `document.getElementById('g-recaptcha-response').value = token`
- hCaptcha → `h-captcha-response`
- Turnstile → `input[name="cf-turnstile-response"]` (+ re-fire `turnstile` `onSuccess`)
- FriendlyCaptcha → `frc-captcha-solution`
- Arkose → `input[name="fc-token"]` + `window.FC_callback` / Arkose `onCompleted`

---

## 5. Solver SDK / HTTP Integration Pattern (pluggable, feature-flagged)

The clean way to add an optional solver to a Puppeteer/CDP server is a **provider
abstraction behind a feature flag**, with graceful degradation when no API key is set.
`puppeteer-extra-plugin-recaptcha` is the reference implementation (detect → extract
config + sitekey → delegate to a `provider` → inject token → fire callback).

### 5.1 Design
- **Interface:** a single `SolverProvider` with `solve({ type, sitekey, pageurl, proxy,
  action, minScore }) => Promise<token>` and `inject(page, type, token)`.
- **Feature flag:** enabled only when an API key is configured (env or JSON). When
  unset, the server falls back to HITL / returns a structured "challenge encountered"
  result — **graceful degradation, never a hard failure.**
- **Config via env/JSON:** `SMOOTH_OPERATOR_SOLVER_PROVIDER` (`none`|`2captcha`|
  `capsolver`|`anticaptcha`|…), `SMOOTH_OPERATOR_SOLVER_API_KEY`, optional `proxy`.
  Validate and normalize on startup; never log the key.
- **Detection → routing:** a small matcher maps widget class to provider `type`
  (`g-recaptcha`→`userrecaptcha`, `h-captcha`→`hcaptcha`, `cf-turnstile`→`turnstile`,
  `frc-captcha`→`friendly_captcha`, `data-pkey`→`funcaptcha`).
- **Bounded & cancellable:** each solve has a deadline; poll with a max timeout; on
  timeout, retire the task and surface the challenge (HITL) rather than hang the queue.
- **IP consistency:** when a proxy is configured, pass it to the solver and use the same
  proxy for the page session.
- **Token lifecycle:** tokens are single-use and short-lived (2 min reCAPTCHA/hCaptcha,
  5 min Turnstile) — mint close to submission; re-fire JS callbacks where needed.

### 5.2 Skeleton (TypeScript)

```ts
export interface SolveRequest {
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile'
       | 'friendly' | 'funcaptcha' | 'geetest_v3' | 'geetest_v4';
  sitekey: string;
  pageurl: string;
  proxy?: string;          // http://user:pass@host:port
  action?: string;         // reCAPTCHA v3
  minScore?: number;       // reCAPTCHA v3
}
export interface SolverProvider {
  readonly name: string;
  solve(req: SolveRequest): Promise<string>;   // returns token
  inject(page: Page, req: SolveRequest, token: string): Promise<void>;
}

// Provider factories
function make2Captcha(key: string): SolverProvider { /* in.php / res.php poll */ }
function makeCapSolver(key: string): SolverProvider { /* createTask / getTaskResult */ }
function makeAntiCaptcha(key: string): SolverProvider { /* createTask / getTaskResult */ }

export function buildSolver(cfg: {
  provider: 'none' | '2captcha' | 'capsolver' | 'anticaptcha';
  apiKey?: string;
  proxy?: string;
}): SolverProvider | null {
  switch (cfg.provider) {
    case '2captcha':   return cfg.apiKey ? make2Captcha(cfg.apiKey) : null;
    case 'capsolver':  return cfg.apiKey ? makeCapSolver(cfg.apiKey) : null;
    case 'anticaptcha':return cfg.apiKey ? makeAntiCaptcha(cfg.apiKey) : null;
    default:           return null;   // -> HITL / structured challenge result
  }
}

// Call site (in mcp.ts boundary, after validation)
async function handleCaptcha(page, detected, solver): Promise<'solved' | 'hitl' | 'failed'> {
  if (!solver) return 'hitl';                      // no provider configured
  try {
    const token = await withDeadline(solver.solve({
      type: detected.type, sitekey: detected.sitekey, pageurl: detected.pageurl,
      proxy: solverProxy, action: detected.action, minScore: detected.minScore,
    }, 30_000));
    await solver.inject(page, detected, token);      // set field + re-fire callback
    return 'solved';
  } catch (e) {
    return 'hitl';                                   // degrade to human
  }
}
```

### 5.3 Canonical example requests
- **2Captcha (reCAPTCHA v2):** `POST in.php` with `method=userrecaptcha&googlekey=<sitekey>&pageurl=<url>&json=1` → poll `res.php?action=get&id=<task>` until `status=1`.
- **CapSolver (token):** `POST /createTask` `{ clientKey, task: { type:'ReCaptchaV2TaskProxyLess', websiteKey, websiteURL } }` → poll `/getTaskResult` until `status:ready`.
- **Anti-Captcha:** `createTask` with `RecaptchaV2TaskProxyless`/`FriendlyCaptchaTaskProxyless` → `getTaskResult`.
- **GeeTest v4 (CapSolver):** `GeeTestTaskProxyLess` with `captchaId`; solution returns `{ captcha_id, captcha_output, gen_time, lot_number, pass_token, risk_type }`.

---

## 6. Score-Based CAPTCHA (reCAPTCHA v3, Turnstile)

**Why they're harder:** there is **no explicit solve step**. The vendor mints an
action-bound token and returns a score; the *site* decides allow/block from the score.
So "solving" = producing a request that **scores like a human** across reputation,
history, and execution signals — not passing an image grid.

**Consequences for automation:**
- **Stealth + behavioral realism dominate.** `navigator.webdriver`, `HeadlessChrome`,
  CDP side effects, JS globals, TLS/HTTP2 fingerprint, mouse/timing, and session warmth
  all feed the score. A fresh proxy with no history scores ~0.1 regardless of solver.
- **Token quality varies.** Benchmarks show solvers returning *valid* v3 tokens that all
  carry a **0.10** score — the site still blocks. CapSolver reports 0.7–0.9 but cannot
  guarantee it.
- **Action binding.** The token is tied to an `action`; the site verifies it matches, so
  the solve must be minted at the point of the real action (login/checkout), not page load.
- **reCAPTCHA vs hCaptcha Enterprise score polarity** (see §1.2) — the same 0.0–1.0 field
  means opposite things; a ported threshold inverts the policy.
- **Prevention is the only real lever.** Clean residential/mobile IP, real-browser
  fingerprint, warm session, human pacing. Solvers are a thin, imperfect supplement.

---

## 7. Arkose — Why Falcon / FunCaptcha Is the Hardest

**Why it resists remote solving:**
1. **Score-then-challenge.** Arkose scores the whole session (225+ signals: IP, device,
   behavior) *before* anything renders. A clean session gets `suppressed:true` and no
   game at all; the puzzle is served only when the score is against you. So the durable
   goal is to make the puzzle **rare**, not to solve every one.
2. **Single-use, session-bound token.** The `dapib` proof-of-work binds a solved answer to
   the exact session that solved it; the token is verified server-side against a private
   key and cannot be replayed or farmed. There is **nothing to stockpile**.
3. **Session context travels with the token.** A token solved on a different IP/fingerprint
   than the submitting session can still verify poorly — so a solver must solve from the
   *same* IP and context.
4. **Economic design.** Adaptive difficulty (more rounds, more distractors, time pressure)
   and device-adaptive proof-of-work (Low→Extreme, scaled to hardware) make bulk solving
   deliberately expensive. ~1,250+ variants means a solver tuned to one breaks on the next.
5. **Requires a real browser.** A `requests`/`axios` client has no JS engine to run the
   collection script and produces no token; its TLS/HTTP2 fingerprint matches no browser.

**Community approaches (and their limits):**
- **Residential/mobile proxies** lower the risk score → fewer/easier challenges. They fix
  the IP input but **not** headless tells or the token binding.
- **Fortified real browsers** (hardened Playwright/Puppeteer with automation tells patched,
  or anti-detect browsers) to score as a genuine device.
- **Human pacing + warm sessions** (natural path, randomized delays, modest per-IP volume).
- **Commercial solvers** for the rare leftovers (2–3× the price, 15–30s, ~88% success),
  passing the page's `blob` data and matching IP/context.
- **Official API / account paths** when a site exposes one — often skips the challenge.
- **Deobfuscation tooling** (`unfuncaptcha`, `chaser-gt`) that reverse-engineers the
  `bda` payload and signature — fragile, because Arkose rotates the collection client and
  the blob breaks on every update.

**Bottom line:** against Arkose, prevention (clean IP + real browser + behavior) is the
strategy; solving is an expensive fallback for the challenges that slip through. No proxy
solves the puzzle; a solver returns a token that is necessary but not sufficient.

---

## 8. Recommendations for the Smooth-Operator Server

Given the server's constraints (Puppeteer/CDP, headed private browser, policy-enforced,
no model loop), a responsible CAPTCHA posture is:

1. **Detect reliably and cheaply.** Classify the challenge from widget class / script
   domain / response field (`g-recaptcha`, `h-captcha`, `cf-turnstile`, `frc-captcha`,
   `data-pkey`, `gt`/`captchaId`). Bounded, untrusted wrappers.
2. **Prevent by default.** Keep the private headed browser clean, patch the obvious
   automation tells (`navigator.webdriver`, `HeadlessChrome`, CDP), use consistent
   UA/TLS/fingerprint, and pace. This removes most challenges.
3. **Human-in-the-loop as the primary solve path.** The server already runs a headed
   browser; surface a challenge and wait for the human (gated seam). Highest reliability,
   no third-party dependency, no IP mismatch.
4. **Optional, pluggable solver behind a feature flag.** Provider abstraction,
   env/JSON config, graceful fallback to HITL when no key is set. Respect rate limits and
   token lifetimes; inject into the correct field and re-fire callbacks.
5. **Never claim to bypass CAPTCHA.** Report challenges (the server already has
   `browser_challenge`), pass context (IP/blob) to solvers, and document limitations.
   Honor target ToS and applicable laws.

*Sources: Google reCAPTCHA/Enterprise docs, Cloudflare Turnstile docs, hCaptcha docs,
Geetest docs, FriendlyCaptcha docs, Arkose Labs engineering blog, plus technical write-ups
(crawlex.net, penligent.ai, GigAZINE) and provider pages (2Captcha, Anti-Captcha,
CapSolver, DeathByCaptcha, NoneCap, NopeCHA) and benchmark/analysis articles (scrapfly,
xProxy Market, CaptchaAI, Castle, DataDome). Provider pricing/accuracy figures are
vendor-reported and should be benchmarked against the live target before relying on them.*
