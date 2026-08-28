# Technical Review: STEALTH-CAPTCHA-PLAN.md

**Target:** `smooth-operator-mcp` — `puppeteer-core` `^25.9.0` + system Chromium-based Chrome
**Reviewer scope:** Validate the technical approach, flag gaps/risks/corrections before implementation.
**Method:** Cross-checked against the installed Puppeteer-core `25.9.0` type definitions
(`lib/types.d.ts`), the live `service.ts` launch/configure/challenge code paths, `compatibility.ts`,
and the published HTTP contracts of CapSolver / 2Captcha / 9Captcha. Where a claim could be pinned to
a source, the source is cited inline.

**Bottom line:** The plan is architecturally sound and its opt-in/layered design fits the codebase's
existing one-shot `configurePage` guards and operation-lock discipline well. It is, however, built on
**three concrete API errors** that will fail to compile or misbehave at runtime, plus several
under-addressed runtime concerns (per-page/per-popup injection, connect-mode limits, solver
contract details). The two highest-value phases (baseline stealth, JS fingerprint bundle) are
correct in direction; the `--headless=new`/`headless:'new'` handling and the init-script API need
corrections before code is written.

---

## 0. Verified facts (authoritative sources)

| Fact | Source |
|---|---|
| `puppeteer-core` is `^25.9.0` (no bundled Chromium — uses system Chrome via `findChromeExecutable`) | `package.json`; `service.ts` `connectBrowser` |
| `Page.evaluateOnNewDocument<Params,Func>(pageFunction: Func \| string, ...args): Promise<NewDocumentScriptEvaluation>`; `NewDocumentScriptEvaluation = { identifier: string }` | `types.d.ts` L7297–7303, L5884 |
| `Page.addScriptToEvaluateOnNewDocument` **does NOT exist** on the v25 `Page` interface | `types.d.ts` — grep for `addScriptToEvaluateOnNewDocument` is empty; only `addScriptTag` remains |
| `Browser.callCDP` **does NOT exist** in v25; `Browser.createCDPSession(): Promise<CDPSession>` does | `types.d.ts` L9485; no `callCDP` anywhere |
| `LaunchOptions.headless?: boolean \| 'shell'`, default `true`; `true` = new headless, `'shell'` = old shell | `types.d.ts` L5210–5224 |
| `evaluateOnNewDocument` injects via CDP `Page.addScriptToEvaluateOnNewDocument` (main world, runs before page scripts) | pptr.dev `Page.evaluateOnNewDocument`; crawlex.net "CDP addScriptToEvaluateOnNewDocument trap" |
| `evaluateOnNewDocument` is **per-page**; new tabs/popups are NOT covered until re-injected | puppeteer/puppeteer issue #3324 |
| 2Captcha: `in.php` POST (`key/method/userrecaptcha/googlekey/pageurl/json`) → `{status:1,request:<id>}`; `res.php` GET (`key/action/get/id/json`) → `{status:1,request:<token>}` or `CAPCHA_NOT_READY`; `callback` disables polling; `pollingInterval ≥ 5s`; defaultTimeout 120 / recaptchaTimeout 600; token → `g-recaptcha-response` | 2captcha.com/2captcha-api docs |
| CapSolver: REST `POST /createTask` (`clientKey`,`task:{type,websiteURL,websiteKey,…}`) → `{taskId}`; poll `POST /getTaskResult` (`clientKey,taskId`) → `status: ready|processing` + `solution.gRecaptchaResponse`; also has a WebSocket/SDK real-time path | docs.capsolver.com |

---

## 1. Puppeteer-core 25 init-script API — CORRECT API + isolation

**Plan claims (lines 24, 68, 132, 161):** inject a bundled source string via
`page.evaluateOnNewDocument(fn)` **vs** `page.addScriptToEvaluateOnNewDocument(source)` **vs**
`browser.callCDP`.

**Corrections:**

- **`page.addScriptToEvaluateOnNewDocument(source)` does not exist in v25.** The `Page` interface
  dropped the string-based method; only `evaluateOnNewDocument` (which now accepts a `Func | string`)
  and `removeScriptToEvaluateOnNewDocument(identifier)` remain. The plan's "primary API" is a
  non-existent method — this must be replaced with `page.evaluateOnNewDocument(sourceString)`.
  Puppeteer serializes the string itself (CDP `Page.addScriptToEvaluateOnNewDocument`), so a bundled
  source string works directly: `await page.evaluateOnNewDocument(stealthSource);`.
- **`browser.callCDP` does not exist in v25.** For direct CDP injection use
  `page.target().createCDPSession().send('Page.addScriptToEvaluateOnNewDocument', { source })` or
  `browser.createCDPSession()`. In practice you do **not** need raw CDP here — `page.evaluateOnNewDocument`
  already emits the exact same CDP command. Reserve `createCDPSession` only if a future phase needs
  `worldName` control (see below).
- **Best choice for a bundled source string:** `page.evaluateOnNewDocument(sourceString)`. It is the
  stable public API, returns an `{ identifier }` you can pass to `removeScriptToEvaluateOnNewDocument`
  if you ever need to uninstall it, and it runs in the **main world** — which is exactly what stealth
  patches need (they must patch the globals the page's own scripts see).
- **Isolation/main-world:** `evaluateOnNewDocument` runs via CDP `Page.addScriptToEvaluateOnNewDocument`,
  which defaults to the **main world** and runs before any page script. This is correct for fingerprint
  patches. Caveat (the "trap"): it does **not** run inside the page's isolated execution context, and it
  does not re-run for SPA (same-document) navigations — it runs once per new *document*. Fingerprint
  patches are one-time global mutations, so this is fine; just don't expect it to re-fire on client-side
  route changes (it shouldn't need to).
- **v25 gotcha:** because the string form is now `evaluateOnNewDocument`, keep the source as a plain
  string constant (see §6 for the one-shot injection strategy). Do **not** write `page.addScriptToEvaluateOnNewDocument`.

---

## 2. `--headless=new` correctness — TWO ERRORS

**Plan claims (lines 21, 104, 117–118, 248):** `--headless=new` as a launch arg; "coerce to
`headless:'new'`"; worry about what `headless:true` resolves to.

**Corrections:**

1. **`headless:'new'` is invalid in v25.** The type is `headless?: boolean \| 'shell'` (L5210–5224).
   Valid values are `true` (new headless) or `'shell'` (old Chrome Headless Shell). There is **no**
   `'new'` string literal. `headless:'new'` is a compile error and a no-op at runtime. Use
   `headless: true`.
2. **`headless: true` already means new headless** in Puppeteer 25 (the type doc explicitly says
   `true` → new headless; `'shell'` → old shell). So the plan's worry is inverted: `headless:true` is
   the *modern* mode, not the old one. Puppeteer's own `defaultArgs` pushes `--headless=new` when
   `headless:true`.
3. **Don't pass `--headless=new` as a raw arg *and* set `headless:true`.** That risks a duplicate
   `--headless=new` in the arg list. Chrome tolerates duplicates (last wins, same value), but it's
   sloppy and the plan's `compatibility.ts` dedup rule would need to handle it. **Recommendation:**
   drive headless through the `headless: true` launch option (Puppeteer emits `--headless=new`), and
   put only the *non-headless* stealth flags (`--disable-blink-features=AutomationControlled`,
   `--lang`, `--window-size`, `--disable-dev-shm-usage`) into the args array.
4. **Scoped correctly, but must be mode-aware:** headless coercion only applies to the **launch/managed**
   paths (`connectBrowser` L2975–3006). For `connect`/`url`/`wsEndpoint` modes the headless state is
   decided by the *remote* browser — you cannot coerce it. The plan should state explicitly that Phase 1
   stealth baseline is **launch/managed-only**, and that `connect` (personal Chrome) gets only the
   JS-fingerprint + behavioral layers, not the launch-arg layer.
5. **Bundled Chromium question:** this project uses `puppeteer-core` (no bundled Chromium) and discovers
   system Chrome. So there is no bundled-binary drift to worry about — headless semantics follow the
   **user's installed Chrome** version. This is actually *good* for stealth (real Chrome). Minor caveat:
   `--headless=new` requires Chrome 85+; on a very old system Chrome the flag is ignored. Acceptable for
   an opt-in feature, but worth one line in the docs.

---

## 3. Solver provider API contracts — sound abstraction, wrong/underspecified details

**Plan claim (lines 214–231):** a uniform `SolverProvider` contract (detect → submit sitekey/pageurl/proxy
→ poll → inject token + re-fire callback), providers `capsolver`, `2captcha`, `9captcha`, HTTP only.

The abstraction is **sound** (interface + per-provider adapter + graceful fallback). But the per-provider
contracts below need correction/precision:

- **2Captcha — GET polling (correct in plan, add these details):**
  - Submit: `POST https://2captcha.com/in.php` with form fields `key`, `method=userrecaptcha`,
    `googlekey=<sitekey>`, `pageurl=<url>`, `json=1` (and `reaptcha=1`/`enterprise=1` for v3/enterprise).
    Returns `{status:1, request:<captchaId>}` or `{status:0,request:<errordesc>}`.
  - Poll: **`GET`** `https://2captcha.com/res.php?key=..&action=get&id=<id>&json=1`.
    Returns `{status:1, request:<token>}` (done) or `{status:0, request:"CAPCHA_NOT_READY"}` (keep polling).
    Token is written to `g-recaptcha-response`.
  - **Gotcha 1 (critical for the "uniform contract"):** if a `callback` URL is configured on the
    account/instance, 2Captcha returns **only the captcha ID and does NOT poll** — results are pushed
    via pingback. The plan's polling loop must assume **no callback** is set (or handle the callback
    branch). Default accounts have no callback, so polling works, but this is a common footgun.
  - **Gotcha 2:** `pollingInterval` must be **≥ 5s** (API says <5s not recommended); `defaultTimeout=120s`,
    `recaptchaTimeout=600s`. The plan's 120s solver deadline is fine but should use a staggered backoff,
    not a tight poll.
- **CapSolver — REST is the default; WebSocket is optional:**
  - Submit: `POST https://api.capsolver.com/createTask` with `{"clientKey":..,"task":{"type":"NoCaptchaTaskGeneral"|"ReCaptchaV3TaskGeneralRequest"|"CloudflareTurnstileTaskGeneral","websiteURL":..,"websiteKey":..,"(action)?:.."}}`.
    Returns `{"errorId":0,"taskId":"..","errorId":0}`.
  - Poll: `POST https://api.capsolver.com/getTaskResult` with `{"clientKey":..,"taskId":".."}`.
    Returns `{"errorId":0,"status":"processing","solution":{}}` (keep polling) or
    `{"errorId":0,"status":"ready","solution":{"gRecaptchaResponse":"<token>"}}`.
  - **Gotcha:** CapSolver **also has a WebSocket / SDK real-time path** (`createTaskGeneral` + socket,
    and the official SDK's `handlers`). The plan says "HTTP only" — that's fine and simpler, but note the
    WebSocket path exists and is faster; "HTTP only" is a deliberate simplification, document it.
  - Task **type names differ per challenge** (v2 vs v3 vs Turnstile vs hCaptcha). The adapter must map
    `ChallengeKind → provider task type` precisely, and the **token field differs** (`gRecaptchaResponse`
    vs `cfTurnstileResponse` vs `hCaptchaResponse`). The plan's "inject token into provider-specific field
    + re-fire callback" is correct but the field/selector map must be data-driven, not hardcoded.
- **9Captcha / Anti-Captcha:**
  - Anti-Captcha (`9captcha.com`) uses the **same HTTP shape as 2Captcha** (`in.php`/`res.php` family but
    on `9captcha.com`): `POST /in.php` with `key=captchakey&method=userrecaptcha&googlekey=..&pageurl=..&json=1`
    → `{request:<id>}`; `GET /res.php?action=get&id=<id>&json=1` → `{status:1,request:<token>}`.
  - **Naming gotcha:** the npm/domain "9captcha" is Anti-Captcha's newer brand; the classic domain is
    `2captcha.com`. The plan lists both `2captcha` and `9captcha` as separate providers — verify the
    exact base URLs and that the plan isn't treating one service as two. Recommend pinning exact
    `baseURL` per provider via `SMOOTH_OPERATOR_CAPTCHA_SOLVER_URL`.
- **Uniformity caveat:** the three providers differ in (a) POST-vs-GET polling, (b) response envelope
  (`status`/`request` vs `status`/`solution`), (c) token field name, (d) task-type names, (e) proxy
  field shape (`proxy:{type,uri}` for 2Captcha vs `proxy` string for CapSolver). The `SolverProvider`
  interface is the right place to hide these — **each adapter owns its own request/parsing/poll logic**,
  exposing only the uniform `solve()`/`SolveResult`. The plan already does this; just ensure the adapter
  boundary is strict so provider quirks don't leak.

---

## 4. Behavioral realism — `ghost-cursor` is a good, mature dependency; porting is optional

**Plan claim (lines 167–188):** "thin custom behavior layer… A thin wrapper, not a dependency."

`ghost-cursor` (npm, `Xetera/ghost-cursor`) is the de-facto standard Puppeteer mouse-realism library:
mature, bezier-based, `GhostCursor`/`createCursor`, `moveTo`/`click`/`getElement`/`getLocation`, with
overshoot/re-adjust handling. There are official forks (`ghost-cursor-frames`, `ghost-cursor-playwright`).

**Tradeoff analysis:**

- **Use the dependency (recommend).** It's small, well-maintained, battle-tested in production scrapers,
  and the bezier/jitter math is subtle enough that a hand-roll is likely to have off-by-something timing
  bugs. Given the feature is **opt-in and feature-flagged** (isolated), the supply-chain and version-drift
  risk is low and contained.
- **When to port instead:** if zero-dependency is a hard project constraint, port it as a single
  clearly-separated module (`browser/behavior/movement.ts`) with its own unit tests (Bezier math, timing
  bounds) and pin the version history in a vendored file. The plan's "never on the critical path unless
  enabled / single boolean guard" design already keeps default latency unchanged, so the dependency's
  footprint is only paid when enabled.
- **Bigger critique (not the dependency itself):** behavioral realism is the **lowest-leverage** phase.
  Token-gated challenges (reCAPTCHA/Turnstile/hCaptcha) are decided by JS fingerprint + risk scoring,
  not mouse trajectory. Mouse realism mainly helps *score-based* passive checks and human-review
  heuristics. So Phase 3 is more polish than punch — keep it small and last, exactly as the plan
  sequences it. Don't over-invest here.

---

## 5. CDP `Runtime.enable` tell — real but marginal for Puppeteer; don't over-invest in Phase 2

**Plan concern (lines 129–163, "Phase 2"):** `Runtime.enable` serialization flagged as a 2026 tell;
should Phase 2 worry about it?

**Honest feasibility assessment:**

- **What the tell actually is:** a debugger attached via CDP can be inferred from (a) the
  `Runtime.executionContextCreated` events revealing an isolated/`#puppeteer` execution context, and
  (b) the page-level `__puppeteer_devtools_receiver__` global that Puppeteer sets when a **DevTools
  session is attached to that page**. The "serialization" flavor = `Runtime.evaluate` responses carrying
  `callId`/`executionContextId` metadata when `Runtime.enable` is on.
- **This is mostly a Playwright/patchright concern.** Playwright's `evaluate` explicitly uses an isolated
  execution context and its `Runtime.evaluate` response shape is what patchright/undetectables patch.
  Puppeteer's `page.evaluate` runs in the **main world** and the `detectChallenge` probe (service.ts
  L5777) is a single main-world evaluate — a small, existing tell, not a new one.
- **The tell already exists in this codebase** via the target guard / viewport / download CDP sessions
  (`page.createCDPSession`), which set the DevTools receiver. Stealth's `evaluateOnNewDocument` adds a
  `Page.addScriptToEvaluateOnNewDocument` CDP command but **not** a page-level receiver, so the marginal
  new tell from the init script is small.
- **Reachable mitigations from Puppeteer:** the **fingerprint bundle (Phase 2)** — hide
  `navigator.webdriver`, fabricate `window.chrome`, patch `plugins`/`mimeTypes`, `languages`,
  `userAgentData`, and `toString`/`Proxy` traces — addresses ~90% of **page-side** tells. That's the
  right and sufficient focus for Phase 2.
- **CDP-level tell (executionContext isolation):** fully eliminating it requires raw CDP interception
  (`page.target().createCDPSession()` + wrapping `.send` to scrub `evaluate` responses / context names)
  — patchright-style hardening. This is **doable but heavy, fragile across Chromium versions, and
  barely measurable** for this use case. **Recommendation:** make it an explicit "later / optional" item
  (or a research spike), NOT a Phase 2 deliverable. The plan should state that Phase 2 targets
  page-side fingerprint coherence and defers CDP-response scrubbing.

---

## 6. Performance/latency — one-shot per-page injection; keep default path zero-overhead

**Plan claims (lines 187–188):** default path is a single boolean guard → zero cost.

- **Init script is a ONE-TIME per-page CDP call.** `page.evaluateOnNewDocument(source)` is a single
  `Page.addScriptToEvaluateOnNewDocument` round-trip at page creation; Puppeteer then re-runs the script
  on every *future* document in that page automatically. So inject **once**, not per-navigation.
- **Where to inject (follow the existing one-shot pattern).** `configurePageUnlocked` (service.ts
  L3887) already has one-shot guards: `timeoutsConfigured`, `viewportConfigured`, `downloadConfigured`,
  `navigationGuardInstalled`. Add an identical `stealthInjected` guard and inject inside
  `configurePageUnlocked` (or `newPageState`) behind `STEALTH_ENABLED && !state.stealthInjected`. This
  gives the same "configure once, cache forever" semantics the rest of the module uses.
- **Source size matters because it runs on EVERY document load (and every iframe).** Keep the
  `balanced` profile tiny; the `max` profile multiplies per-load CPU. The plan mentions this — quantify
  it (e.g., a target budget of a few KB / sub-ms per load) in the verification step.
- **Per-page, not per-browser.** `evaluateOnNewDocument` is page-scoped, so N pages → N injections.
  Acceptable, but note it in the design (it's O(pages), not O(1)).
- **Default path zero-overhead:** the plan's "single boolean guard" for behavior + "inject only when
  `STEALTH_ENABLED`" for the script is correct. Ensure the guard check is a plain boolean read (no config
  object lookup, no string compare on the hot action path).
- **Solver:** invoked only via explicit `browser_solve_challenge`, bounded by `SMOOTH_OPERATOR_CAPTCHA_SOLVER_TIMEOUT_MS`,
  inside the operation lock. Zero default overhead. Good.
- **Caching:** the init script is inherently cached by Chromium once injected (no re-inject per nav).
  The only "cache" you manage is the `stealthInjected` flag. No additional response caching needed.

---

## 7. Gaps the plan UNDER-ADDRESSED or MISSED

1. **Per-page & per-popup injection (MISSED, highest priority).** `evaluateOnNewDocument` is per-page
   (puppeteer issue #3324: "detected because evaluateOnNewDocument is not set for this new page"). The
   plan wires injection into `configurePage`/`newPageState`, but **popups / `targetcreated` pages**
   (service.ts L3236 `browser.on('targetcreated')`) and `_blank` link navigations can bypass
   `newPageState`. Every page that enters `states` must get the init script. Add a guard in the popup /
   target-attach path, or inject in a single choke point that all page states funnel through.
2. **`connect` mode can't get the baseline (MISSED).** Launch args (`--headless=new`,
   `--disable-blink-features=AutomationControlled`) only apply to launch/managed. For `connect`/personal
   Chrome the browser is already running; only the JS-fingerprint + behavioral layers apply. The plan
   should explicitly scope Phase 1 to launch/managed and document the connect-mode remainder.
3. **SPA / same-document navigations.** `addScriptToEvaluateOnNewDocument` fires per *document*, not per
   SPA route. Fingerprint patches persist as global mutations (fine), but if any patch relies on
   re-running, it won't. Clarify that patches are one-time global and that solver re-firing is handled
   by the behavioral layer, not the init script.
4. **`bypassAttempted` type change is broader than stated (GAP).** The plan widens `bypassAttempted` from
   literal `false` to `boolean` (lines 235–238, contracts.ts). But `detectChallenge` currently returns
   `bypassAttempted: false` in the error path (service.ts L5884) and the classification shape is used in
   `waitForHuman` polling. Widening the type without a migration plan for the evidence-only classification
   and the contract SHA lock (§10) risks silent false-positives. Ensure the contract snapshot test covers
   the new field and that `false` still means "no solver run," not "challenge absent."
5. **Profile cleanup / warm-profile leakage (UNDER-ADDRESSED).** A persistent profile warms up (good for
   coherence) but accumulates cookies/localStorage/cache. Stale caches can cause wrong behavior; a
   reused profile across many tasks can drift toward a "known bot" fingerprint if the same device
   signals persist. Add a bounded profile-lifecycle policy (e.g., periodic reset or scope the profile to
   the feature) and note it. The plan says "no new data-dir churn" — reconsider for long-running solvers.
6. **Interaction with the CDP Fetch guard (UNDER-ADDRESSED).** The plan's `detectChallenge` uses
   `page.evaluate` (main world) and the solver injects a token + re-fires a callback. But the existing
   `Fetch`/request-interception guard (service.ts L3961–3985, `handleRequest`) can interfere with the
   solver's re-submission (e.g., the re-fired callback triggers a verification request that the guard
   re-validates). The solver's token-injection + re-fire must be coordinated with `challengeActive` and
   the request guard, or it can deadlock/re-block. Add an explicit note + test.
7. **`--headless=new` duplicate arg (from §2).** If the plan keeps `--headless=new` in `STEALTH_BASELINE_ARGS`
   while also setting `headless:true`, dedup must handle it. Recommend dropping the raw flag in favor of
   the `headless:true` option (see §2.3).
8. **CI headless default (UNDER-ADDRESSED).** `SMOOTH_OPERATOR_BROWSER_HEADLESS=true` (CI) already resolves
   to new headless in v25. The plan says "coerce to headless:'new'" — but CI is *already* new headless;
   the coercion is a no-op there and only matters for headed default sessions. Clarify so CI behavior is
   unchanged.
9. **Memory overhead of the init script (UNDER-ADDRESSED).** The bundle lives in the renderer for the
   page's lifetime and re-runs per document. For `max` profile with WebGL/Intl/timezone patches, this is
   more heap + per-load CPU. Quantify and cap; consider a `balanced`-only default (the plan already does).
10. **Provider URL / API-key routing & no-key fallback (underspecified).** The plan says "no API key =
    graceful HITL fallback." Ensure the gate is evaluated *before* any HTTP call and that `SMOOTH_OPERATOR_CAPTCHA_SOLVER_URL`
    overrides are validated against the allowlist (same policy as other URLs). Solvers are third-party
    HTTP endpoints — they must go through the same DNS/URL preflight as the rest of the server.

---

## Prioritized findings

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | **Critical** | `page.addScriptToEvaluateOnNewDocument` doesn't exist in v25 → use `page.evaluateOnNewDocument(source)` | §1, §2 |
| 2 | **Critical** | `headless:'new'` is invalid → type is `boolean \| 'shell'`; use `headless: true` | §2 |
| 3 | **High** | `browser.callCDP` doesn't exist → use `createCDPSession()` (or not at all) | §1 |
| 4 | **High** | Per-page/per-popup injection gap (issue #3324) — new tabs stay detectable | §7.1 |
| 5 | **High** | `connect` mode can't receive launch-arg baseline; Phase 1 must be launch/managed-only | §7.2 |
| 6 | **Medium** | 2Captcha GET-polling + `callback` polling-disable gotcha; CapSolver task-type/token-field mapping; 9captcha vs 2captcha identity | §3 |
| 7 | **Medium** | Solver must coordinate with the existing Fetch/request-interception guard & `challengeActive` | §7.6 |
| 8 | **Medium** | `bypassAttempted` type widening needs contract-SHA + evidence-classification migration | §7.4 |
| 9 | **Low** | `Runtime.enable` tell over-scoped for Phase 2; defer CDP-response scrubbing | §5 |
| 10 | **Low** | Behavioral realism is lowest-leverage phase; keep it smallest/last | §4 |

---

## Recommended plan edits (in order)

1. Replace `addScriptToEvaluateOnNewDocument(source)` → `evaluateOnNewDocument(source)`; drop `browser.callCDP`.
2. Replace `headless:'new'` → `headless: true`; drop `--headless=new` from `STEALTH_BASELINE_ARGS` (let Puppeteer emit it); keep only non-headless stealth flags in args.
3. Scope Phase 1 baseline to launch/managed; document connect-mode remainder.
4. Add per-page/per-popup injection choke point + `stealthInjected` one-shot guard in `configurePageUnlocked`.
5. Tighten solver adapters: 2Captcha GET-polling/no-callback, CapSolver REST+task-type map, 9captcha identity/baseURL; strict `SolverProvider` boundary.
6. Coordinate solver token-injection/re-fire with the Fetch guard + `challengeActive`.
7. Widen `bypassAttempted` with a contract-SHA migration + evidence-classification update.
8. Defer CDP `Runtime` response scrubbing to a research spike; keep Phase 2 = fingerprint coherence.
9. Add profile-lifecycle note; quantify init-script size/per-load cost.
