# SmoothOperator — Stealth + CAPTCHA Handling: Implementation Plan

**Target:** `smooth-operator-mcp` (Node.js MCP server, Puppeteer-core ^25, Chromium-based)
**Goal:** Raise task-success rate (currently ~14/100 blocked by CAPTCHA/anti-bot) via a
masterwork, opt-in **stealth** capability and a responsible **CAPTCHA-handling** workflow,
while preserving the project's "secure by default" thesis and its performance/latency profile.

---

## 0. Executive Summary

The codebase is deliberately **identity-preserving and non-spoofing** — no User-Agent override,
no `--disable-blink-features`, no `webdriver` patch, and `bypassAttempted:false` is hard-coded at
every challenge return path. The strongest design tension is therefore: *how do we add stealth +
CAPTCHA handling without gutting the "secure by default" thesis?*

**Resolution: make both features opt-in, layered, and feature-flagged — default OFF, exactly like
the existing `browser_evaluate` / `allowEval` gate.** The default build stays identity-preserving
and fails closed (unchanged). A user who opts into a `stealth` profile gets:

1. **Stealth baseline** — `headless:true` (new headless in Puppeteer-core 25) + real Chrome +
   `--disable-blink-features=AutomationControlled` + persistent profile + coherent `--lang`/
   `--window-size`. High leverage, near-zero overhead, no in-page patches. (Launch-arg scope:
   `managed`/`launch` only.)
2. **JS fingerprint bundle** — a minimal, coherent `evaluateOnNewDocument` patch set
   (`navigator.webdriver`, `plugins`/`mimeTypes`, `window.chrome`, `permissions`, `languages`,
   `userAgentData` brand cleanup), feature-flagged, injected once per page behind a one-shot guard,
   *coherence-over-maximality*.
3. **Behavioral realism layer** — Bezier mouse motion, human typing variance, momentum scroll,
   randomized think-time. Thin wrappers over the `ghost-cursor` dependency (opt-in).
4. **CAPTCHA workflow** — `detect → prevent (patch tells) → human-in-the-loop (primary) → optional
   pluggable solver (opt-in, graceful fallback)`. The existing `browser_challenge` +
   `browser_wait_for_human` become the spine; the solver is a behind-a-flag add-on.

Everything is behind config flags that mirror the existing `allowEval` pattern, so the security
boundary, policy enforcement, and bounded-output discipline are untouched.

---

## 1. Design Principles (carry forward the invariants)

1. **Secure by default, opt-in capability.** `stealth` and solver are OFF unless explicitly enabled
   (`SMOOTH_OPERATOR_STEALTH_ENABLED=true`, `SMOOTH_OPERATOR_CAPTCHA_SOLVER_*`). Default behavior,
   contract, and `bypassAttempted` reporting are unchanged.
2. **Coherence over maximality.** On `--headless=new` many leaks auto-resolve; over-patching a
   correct value with a `Proxy` *increases* detection surface. Ship the *minimal coherent* set.
3. **Two-layer policy intact.** Stealth changes *what the browser is/says*; the `policy.ts`
   preflight + CDP `Fetch` guard remain the navigation boundary and are not weakened.
4. **Bounded + untrusted + redacted.** Any solver response (sitekey, tokens, provider JSON) is
   treated as untrusted, bounded, and redacted exactly like page content.
5. **Deterministic timeouts / queue recovery.** Stealth patches and the solver run inside the
   existing operation lock; a solver call has a bounded deadline and follows the same
   `recoverAfterAbort` retirement path. No new unbounded loops.
6. **Responsible by construction.** Opt-in profiles, prominent notices, human-in-the-loop default
   for hard captchas, politeness/rate-limit defaults, proxy transparency, audit logging, dual-use
   disclaimer (see §13).

---

## 2. Architecture Overview (layered)

```
                         ┌─────────────────────────────────────────────┐
                         │  opt-in gates (config, default OFF)           │
                         │  SMOOTH_OPERATOR_STEALTH_ENABLED             │
                         │  SMOOTH_OPERATOR_STEALTH_PROFILE=balanced|max  │
                         │  SMOOTH_OPERATOR_CAPTCHA_SOLVER=none|<provider>│
                         └─────────────────────────────────────────────┘
   Launch args  →  [1] Stealth Baseline (compatibility.ts / launch; managed+launch modes only)
   Init script  →  [2] JS Fingerprint Bundle (browser/stealth.ts, evaluateOnNewDocument, one-shot)
   Action wrap  →  [3] Behavioral Realism (browser/behavior.ts, click/input/scroll paths)
   Challenge    →  [4] CAPTCHA workflow: detect → prevent → HITL → optional solver (browser/solver.ts)
   All inside existing operation lock + policy + bounded-output pipeline.
```

New modules (all under `src/server/browser/`):
- `stealth.ts` — launch-arg builder + init-script source (via `evaluateOnNewDocument`, feature-flagged).
- `behavior.ts` — human-like mouse/typing/scroll helpers (thin wrappers over `ghost-cursor`).
- `solver.ts` — pluggable CAPTCHA solver provider abstraction + HTTP client (REST/GET per provider) + graceful fallback.
- `fingerprints.ts` — coherent fingerprint set builder (UA + Client Hints + viewport + lang),
  reused by both launch and init-script.

Existing modules touched:
- `browser/compatibility.ts` — add optional stealth flags (append, never mutate shared array).
- `browser/service.ts` — wire stealth baseline + per-page one-shot init-script injection + behavior wrapper + solver hook; scope stealth to opt-in; connect-mode gets JS+behavior layers only.
- `browser/challenges.ts` — extend `RULES` (optional); **`bypassAttempted` (literal `false` at `challenges.ts:34`) widened to `boolean` and set to the truth** reflecting solver activity.
- `config.ts` — add `stealth` + `captchaSolver` config sections (`.strict()` forces explicit keys); env vars read directly from `environment`, JSON file keys added to schema; replace removed-switch guards.
- `contracts.ts` — add `solve_challenge` to `BrowserActionNames` + fields to strict `BrowserActionFieldsSchema` + `.superRefine` case; new dispatch.
- `mcp.ts` — update tool descriptions / MCP_INSTRUCTIONS text; register `browser_solve_challenge` + `actionAnnotations` case.
- `research.ts` — raw `fetch` (not a browser): stealth baseline does NOT apply; only optional polite headers.

---

## 3. Phase 1 — Stealth Baseline (highest leverage, ~zero overhead)

**Files:** `browser/compatibility.ts`, `browser/service.ts` (§2.1 launch path, lines 2975–3006).

Add an *append-only* stealth flag set, gated by `SMOOTH_OPERATOR_STEALTH_ENABLED`:

```ts
// browser/stealth.ts
export const STEALTH_BASELINE_ARGS = [
  "--disable-blink-features=AutomationControlled", // hide navigator.webdriver at the C++ source
  "--lang=en-US",                          // navigator.language / Intl coherence
  "--window-size=1920,1080",               // consistent viewport/screen
];
```

Note: `--disable-background-networking` / `--disable-dev-shm-usage` already exist in
`NATIVE_BROWSER_LAUNCH_ARGS` (compatibility.ts), so they are omitted here to avoid duplication.
`STEALTH_BASELINE_ARGS` is a **separate builder** (never baked into `NATIVE_BROWSER_LAUNCH_ARGS`) so
the default-args test (`browser-compatibility.test.ts`) still asserts a clean default.

**Headless handling (validated against Puppeteer-core 25):**
- In Puppeteer-core 25 the `headless` option type is `boolean | 'shell'`; `headless: true` **already
  means new headless**, and Puppeteer's own `defaultArgs` emits `--headless=new`. Do **not** also
  push `--headless=new` into the args array (that would duplicate/conflict). Coerce via the launch
  **option** instead: in `service.ts` `connectBrowser`, branch `headless = stealthEnabled ? true : this.config.browser.headless`.
  (Widening the config type to accept `'new'` is an alternative but unnecessary.)
- **Scope caveat — connect/ws/url modes bypass launch entirely** (`service.ts` connect path uses
  `this.connect(...)`). The launch-arg baseline therefore applies **only** to `managed` and `launch`
  modes. `connect`/Personal-Chrome modes receive only the JS-fingerprint + behavioral layers (Phase 2/3).

Rules:
- **Merge, don't replace.** `nativeBrowserLaunchArgs()` returns a copy (already does). Stealth
  flags are appended only when enabled; dedup against `--lang`/`--headless` if present.
- **Persistent profile.** The single private profile (`${DATA_DIR}/browser`) is already reused;
  document that warm sessions look human. No new data-dir churn.
- **GPU rendering.** If `SMOOTH_OPERATOR_STEALTH_GPU=true`, add `--use-angle=...`/`--enable-vulkan`
  so WebGL/canvas pixels come from a real GPU (coherence). Default off to preserve speed/portability.

**Why this first:** `headless:true` (new headless) + `AutomationControlled` removes the largest class
of value-level tells with no in-page patch and no latency. This alone should move a large fraction of
the 14/100.

---

## 4. Phase 2 — JS Fingerprint Bundle (coherent, minimal)

**Files:** `browser/stealth.ts` (init source), `browser/service.ts` (inject via
`page.evaluateOnNewDocument` — the modern Puppeteer-core 25 API), `browser/fingerprints.ts`.

Inject **once per new document** (main world, before page scripts) — gated by `STEALTH_ENABLED`
and scaled by `STEALTH_PROFILE` (`balanced` = minimal set; `max` = fuller set).

**API (validated):** Prefer **`page.evaluateOnNewDocument(sourceString)`** (Puppeteer-core 25) — it
accepts a `Func | string`, runs in the main world before page scripts, and returns `{ identifier }`.
(`addScriptToEvaluateOnNewDocument` may still exist in v25 as a fallback; `node_modules` was absent
during validation, so **confirm the installed stub with `tsc`** and use `evaluateOnNewDocument`.)
Inject the bundled source string once per page behind a **`stealthInjected` one-shot guard** (mirroring
the existing `navigationGuardInstalled` pattern) so a single CDP call covers every document/iframe the
page creates. **Per-page gap:** `evaluateOnNewDocument` is per-page, so new tabs/popups that bypass
`newPageState` would stay detectable — every page in `states` must funnel through one injection point
with the one-shot guard.

Patch set (`balanced`, the recommended default):
1. `navigator.webdriver` → delete from `Object.getPrototypeOf(navigator)` (belt-and-suspenders;
   the launch flag is the primary fix).
2. `navigator.plugins` / `navigator.mimeTypes` → only if headless detected empty; rebuild a
   coherent `PluginArray` with bidirectional plugin↔mimeTypes refs and proxy circular refs so
   plugin→mime→plugin loops close. **Skip on `--headless=new` if already populated** (coherence).
3. `window.chrome` → fabricate `chrome.runtime`/`csi`/`loadTimes` with secure-origin guard (HTTPS
   only, matching real Chrome).
4. `navigator.permissions.query` → resolve the "impossible combination" contradiction on insecure
   origins (return a `PermissionStatus`-shaped object whose prototype is `PermissionStatus.prototype`).
5. `navigator.languages` → `['en-US','en']` matching `Accept-Language`.
6. `navigator.userAgentData` brand list → strip the `HeadlessChrome` brand / build a coherent
   `fullVersionList` (best-effort; getter is native).
7. `window.toString` / `Proxy` trace hiding → `makeNativeString` + `patchToString` +
   `stripProxyFromErrors` helpers (ported, minimal).

`max` profile adds: `navigator.hardwareConcurrency`/`deviceMemory` (valid-set constrained:
`deviceMemory ∈ {0.25,0.5,1,2,4,8}`), `maxTouchPoints`, `media.codecs`, `Intl` timezone coherence,
`webgl.vendor/renderer` (only when GPU coherent, else skip to avoid the SwiftShader
impossible-combination), `iframe.contentWindow` (srcdoc), `HTMLMediaElement.canPlayType`.

**Guardrails:**
- All patches are **deterministic per session** (seed once), never random per read.
- Each patch hides itself (`toString`/stack). Over-patching guarded by `STEALTH_PROFILE`.
- Source is a single bundled string (bounded), injected via the existing CDP layer.
- **Coherence gate:** if a patch would contradict the launch fingerprint (e.g., WebGL string vs
  SwiftShader pixels), skip it. Prefer correctness.

---

## 5. Phase 3 — Behavioral Realism Layer

**Files:** `browser/behavior.ts`, wired into `service.ts` click/input/scroll paths.

Behavioral realism is the **lowest-leverage** phase — keep it smallest and last. Use the mature,
de-facto-standard **`ghost-cursor`** npm package (cubic Bezier + jitter + variable speed) as an
**opt-in, feature-flagged dependency** rather than hand-rolling subtle bezier math (contained risk;
isolated behind `STEALTH_ENABLED`, removed if the flag is off). Provide small typed wrappers.

- **Mouse:** cubic Bezier interpolation + per-step Gaussian jitter + variable speed
  (`humanMouseMove(page, x1,y1,x2,y2,duration)`).
- **Typing:** per-keystroke random delay (45–160ms), occasional think-pause (300–900ms),
  occasional backspace; vary vowel/consonant speed.
- **Scroll:** momentum, variable increments, occasional reverse, stop near content (not always
  absolute bottom).
- **Think-time:** randomized delay (hundreds of ms–seconds) between actions.

Integration points (all optional, default bypassed with zero cost):
- `clickElement` / `clickTarget` → `humanMouseMove` to target before click.
- `inputTarget` / `sendKeys` → `humanType` instead of fixed-delay `page.type`.
- `scroll` / `scroll_to_bottom` → momentum scroll.

Performance: when `STEALTH_ENABLED` is off, behavior wrappers are no-ops (a single boolean guard),
so default speed is preserved. The init-script bundle is a **one-time per-page CDP call** that
Chromium re-runs on every document — inject once behind `stealthInjected`, keep `balanced` tiny (it
runs per-load + per-iframe), and keep the default path a single boolean read.

---

## 6. Phase 4 — CAPTCHA Workflow (detect → prevent → HITL → optional solver)

**Files:** `browser/challenges.ts`, `browser/service.ts` (`detectChallenge` 5774–5889,
`waitForHuman` 5891–5922, gate 1164–1169), `browser/solver.ts` (new), `mcp.ts` (new tool).

### 6.1 Detect (already strong) — minor extension
- `classifyChallenge` stays **evidence-only** (never solves). Optionally extend `RULES` with
  `recaptcha-enterprise`, `geetest-v4`, `openai-turnstile`, `kaptcha`, and inverted-score markers
  for hCaptcha Enterprise. Keep the widget-corroboration logic to avoid false positives.

### 6.2 Prevent (stealth does the heavy lifting)
- With `STEALTH_ENABLED`, a **meaningful fraction** of score-based challenges (reCAPTCHA v3,
  Turnstile non-interactive) pass via the baseline + behavioral layer — **when paired with a
  clean/residential IP and a warm, consistent session**. Stealth alone is *necessary but not
  sufficient* against Cloudflare/DataDome/Arkose (per the bot-detection research); IP reputation and
  session warmth are co-factors, not launch args or JS patches. This remains the primary win, but we
  do not overstate it.

### 6.3 Human-in-the-loop (primary solve path — keep as default)
- Improve `browser_wait_for_human`: on challenge present, block mutating actions (already does via
  `CHALLENGE_BLOCKED_ACTIONS`), surface a clear message, poll until `challenge_cleared`.
- Add `browser_challenge` result fields: `provider`, `scoreBased: boolean`, `suggestHuman:true`.

### 6.4 Optional pluggable solver (opt-in, graceful fallback)
- New tool `browser_solve_challenge` (behind a flag; description says "opt-in, may use a solver service").
- `SolverProvider` abstraction (`browser/solver.ts`):
  ```ts
  interface SolverProvider {
    readonly name: string;
    supports(kind: ChallengeKind, scoreBased: boolean): boolean;
    solve(req: SolveRequest, signal: AbortSignal): Promise<SolveResult>;
  }
  interface SolveRequest { sitekey?: string; pageurl: string; kind: ChallengeKind;
                          scoreBased: boolean; proxyUrl?: string; }
  interface SolveResult { token: string; fieldSelector: string; reFireEvent?: string; }
  ```
- Built-in providers (**HTTP-polling only**; CapSolver's WebSocket/SDK path exists but is unused),
  all config via env/JSON, **no API key = graceful HITL fallback**: `capsolver`, `2captcha`,
  `anticaptcha` (the "9captcha" token in early drafts is Anti-Captcha's same service — 9captcha.com
  is its newer domain; standardize on `anticaptcha`). Uniform contract: detect → submit `sitekey`/`pageurl`/`proxy`
  → poll → inject token into the provider-specific field + re-fire the widget callback.
  - **Token field differs per challenge** (not one universal field): `gRecaptchaResponse`
    (reCAPTCHA), `cfTurnstileResponse` (Turnstile), `hCaptchaResponse` (hCaptcha). Map per `kind`.
  - **Provider polling differences:** 2Captcha/Anti-Captcha use **GET** polling and **stops polling if a
    `callback`** URL is configured; CapSolver defaults to **REST** (WebSocket optional) with
    per-challenge task-type names. Pin each provider's base URL.
  - **Interface contract (authoritative):** `solve(req, signal): Promise<SolveResult>` where
    `SolveResult = { token; fieldSelector; reFireEvent? }` — token + injection metadata bundled.
    (Early research drafts used `solve(req): Promise<string>` + a separate `inject()`; adopt the
    bundled form here.)
- **Bounded + redacted:** provider JSON, tokens, and responses are wrapped as untrusted, capped
  (`MAX_SOLVER_BYTES`), and never logged with secrets.
- **Timeouts:** solver call bounded by `SMOOTH_OPERATOR_CAPTCHA_SOLVER_TIMEOUT_MS` (default 120s),
  inside the operation lock, following `recoverAfterAbort`. On timeout/no-key/unsupported → return
  `HUMAN_REQUIRED` and fall back to `browser_wait_for_human`.
- **Coordinate with the existing Fetch/request-interception guard + `challengeActive`** or the
  re-fired callback can deadlock/re-block. The solver runs as an explicit action (not on a blocked
  action) and re-detects with a **fresh snapshot** after injecting (detect_challenge passes through
  `assertSnapshotForAction`).
- **Provider refusals:** many solvers reject datacenter/headless traffic; surface the refusal reason
  (e.g., "datacenter IP blocked") so the user can configure a residential proxy.

### 6.5 `bypassAttempted` semantics change
- Widen the type from literal `false` to `boolean` and **report the truth**: `true` when a solver
  was invoked/attempted, `false` otherwise. This converts a hard invariant into an honest status
  field (see §9).

---

## 7. Config Schema Additions

**`src/server/config.ts`** — add to the strict `browser`/`security` shapes (`.strict()` forces
explicit keys; mirrors `allowEval`):

| Env var | Default | Purpose |
|---|---|---|
| `SMOOTH_OPERATOR_STEALTH_ENABLED` | `false` | Master stealth switch (opt-in) |
| `SMOOTH_OPERATOR_STEALTH_PROFILE` | `balanced` | `balanced` \| `max` |
| `SMOOTH_OPERATOR_STEALTH_GPU` | `false` | Force real-GPU rendering for WebGL/canvas coherence |
| `SMOOTH_OPERATOR_BEHAVIOR_ENABLED` | inherits `STEALTH_ENABLED` | Behavioral realism switch |
| `SMOOTH_OPERATOR_CAPTCHA_SOLVER` | `none` | `none` \| `capsolver` \| `2captcha` \| `anticaptcha` |
| `SMOOTH_OPERATOR_CAPTCHA_SOLVER_API_KEY` | unset | provider key |
| `SMOOTH_OPERATOR_CAPTCHA_SOLVER_URL` | provider default | override endpoint |
| `SMOOTH_OPERATOR_CAPTCHA_SOLVER_PROXY_URL` | unset | residential proxy (transparency) |
| `SMOOTH_OPERATOR_CAPTCHA_SOLVER_TIMEOUT_MS` | `120000` | solver deadline |
| `SMOOTH_OPERATOR_SOLVER_MAX_BYTES` | `1_000_000` | bound solver I/O |

`publicCapabilities()` / `server_health` surfaces the enabled posture (no secrets).

---

## 8. File-by-File Change Summary

| File | Change |
|---|---|
| `browser/stealth.ts` (new) | Launch-arg builder + init-script source (via `evaluateOnNewDocument`) + fingerprint set. |
| `browser/behavior.ts` (new) | Human-like mouse/typing/scroll helpers (thin wrappers over `ghost-cursor`; no-op when disabled). |
| `browser/solver.ts` (new) | `SolverProvider` abstraction, HTTP client (REST/GET per provider), provider impls, fallback. |
| `browser/fingerprints.ts` (new) | Coherent UA + Client Hints + viewport + lang builder. |
| `browser/compatibility.ts` | Append stealth flags when enabled (dedup, no shared-mutation). |
| `browser/service.ts` | Wire baseline (launch/managed only) + per-page one-shot init-script injection + behavior wrapper + solver hook; scope stealth to opt-in; connect-mode gets JS+behavior layers only. |
| `browser/challenges.ts` | Extend `RULES` (optional); **`bypassAttempted` (currently literal `false` at `challenges.ts:34`) widened to `boolean`** and set to the truth (not contracts.ts); **`export type ChallengeKind`** (`challenges.ts:7`) so `solver.ts` can type it. |
| `config.ts` | Add `stealth`/`captchaSolver` shapes + validation; replace removed-switch guards (lines 470–479) with the new knobs. Env vars read directly from `environment`; JSON file keys added to strict schema. |
| `contracts.ts` | Add `solve_challenge` to `BrowserActionNames` enum + fields to strict `BrowserActionFieldsSchema` + a `.superRefine` case; new action dispatch. |
| `mcp.ts` | Update descriptions/MCP_INSTRUCTIONS; register `browser_solve_challenge` + `actionAnnotations` case. |
| `research.ts` | **Raw `fetch`, not a browser** — stealth launch baseline does NOT apply. Only optional polite headers (project deliberately avoids UA overrides). |
| `errors.ts` | New codes: `SOLVER_UNAVAILABLE`, `SOLVER_TIMEOUT`, `SOLVER_REFUSED`. |
| `tests/contract-snapshot.test.ts` | **Re-lock the contract SHA-256** (adding a tool or editing any description changes the hash). |
| `verify-package.mjs` hygiene | New `.ts` files must not introduce `FORBIDDEN_RUNTIME_REFERENCES`; update `.env.example`. |

---

## 9. Removing / Softening Negative Comments (as requested)

Categorized so security-critical invariants are preserved:

**Remove / soften (marketing/stance comments, not safety):**
- `challenges.ts` module doc: *"never attempts to solve, bypass, or disguise a challenge"* →
  *"recognizes evidence exposed by the page; solving/bypassing is opt-in and reported via `bypassAttempted`."*
- `mcp.ts` line 258: *"The server does not solve or bypass CAPTCHA/anti-bot challenges..."* →
  *"CAPTCHA handling is opt-in: stealth + human-in-the-loop by default; an optional solver can be enabled via config."*
- `mcp.ts` line 422/423 tool descriptions ("without attempting to bypass", "never solves or bypasses") →
  neutral/accurate descriptions noting the opt-in solver path.
- `config.ts` removed-switch guards (470–479) that assert *no* `SMOOTH_OPERATOR_BROWSER_STEALTH` /
  `SMOOTH_OPERATOR_BROWSER_USER_AGENT` → **keep** them. The new master switch uses a **distinct name**
  (`SMOOTH_OPERATOR_STEALTH_ENABLED`), so no collision and `config-policy.test.ts` passes unchanged.
  (Do NOT reuse `SMOOTH_OPERATOR_BROWSER_STEALTH` as the new switch — it collides with the guard.)
- `compatibility.ts` line-1 comment *"without altering identity or security"* →
  *"reduces background work; optional stealth flags append here when enabled."*
- AGENTS.md / README / docs "No spoofing, no CAPTCHA bypass" statements → update to
  *"opt-in stealth + CAPTCHA handling; secure by default."*

**KEEP (real invariants that must survive):**
- `bypassAttempted` **field** stays (semantics: report truth), just widen its type.
- `CHALLENGE_BLOCKED_ACTIONS` gate + `challengeActive` enforcement — keep; the solver/HITL flow
  integrates *with* this gate (solver runs explicitly, not on blocked actions).
- Two-layer policy, bounded-output, untrusted-data redaction, queue/deadline recovery — untouched.
- `detect_challenge` remains evidence-only (the *solver* is the new solving path, separate tool).
- `security.ts:22` ("page content cannot **spoof** wrapper boundaries") — this is forged untrusted
  tags, not browser spoofing; keep.

**Caution — `verify-package.mjs` text scan:** `FORBIDDEN_RUNTIME_REFERENCES`
(`scripts/verify-package.mjs:27–37`) flags phrases like `chrome extension`, `content script`,
`model provider`, `service worker`. When editing comments in `challenges.ts`/`mcp.ts`/README/docs,
**avoid** those exact phrases. New `.ts` files map to `../src/server/browser/...` in the sourcemap
check — fine.

---

## 10. Tests

- `browser-stealth.test.ts` (new): launch-arg builder (append/dedup), init-script source validity,
  fingerprint-set coherence, profile gating (balanced vs max), GPU flag.
- `browser-behavior.test.ts` (new): Bezier math, typing variance bounds, no-op when disabled.
- `solver.test.ts` (new): provider abstraction, uniform contract, timeout → HITL fallback,
  no-key graceful degradation, untrusted/bounded response handling, proxy passthrough.
- `config-policy.test.ts` (updated): new env vars accepted/validated; `.strict()` rejects unknown;
  old removed-switch errors replaced by new knobs.
- `challenges.test.ts` (updated): `bypassAttempted` now reports true when solver invoked; new RULES.
- `mcp.test.ts` (updated): tool count assertion `toHaveLength(60)` → **`61`**; add
  `["browser_solve_challenge", { pageId: "missing" }]` to the `calls` array; new tool's schema must
  be `.strict()` (rejects `__smooth_operator_invalid_field__`); annotate `BROWSER_MUTATING`.
- `config-policy.test.ts` (updated): new env vars accepted/validated; `.strict()` rejects unknown;
  **new config fields are OPTIONAL** so `tests/helpers.ts` `testConfig` stays untouched; the
  removed-switch guards (`config.ts:470–479`) are **kept** (distinct new master name
  `SMOOTH_OPERATOR_STEALTH_ENABLED` avoids collision) so this test passes unchanged.
- `challenges.test.ts` (updated): default `bypassAttempted:false` still passes; add a **true-case**
  test calling `classifyChallenge(evidence, { bypassAttempted: true })`.
- `contract-snapshot.test.ts`: **re-lock the SHA-256** after adding the tool + editing
  `MCP_INSTRUCTIONS:258` (compute with the test's own routine, paste the new hex — do this LAST).
- `browser-compatibility.test.ts` (updated): **KEEP** the default assertion (`nativeBrowserLaunchArgs()`
  must still lack `--disable-blink-features=AutomationControlled`); add an **enabled-case** test
  asserting presence when `SMOOTH_OPERATOR_STEALTH_ENABLED=true` (stealth args are a separate builder).

---

## 11. Docs

- Update `README.md`, `docs/mcp-server.md`, `docs/harnesses.md`, `AGENTS.md`, `.env.example`
  for the new flags, the `browser_solve_challenge` tool, and the opt-in posture.
- Add `STEALTH-CAPTCHA-PLAN.md` (this doc) + a `STEALTH-GUIDE.md` (techniques + verification
  targets: bot.sannysoft.com, tls.peet.ws, browserleaks).
- `server_health` / `publicCapabilities` note the enabled posture.

---

## 12. Verification (per AGENTS.md `Verify` gate, extended)

```
npm run lint && npm run typecheck && npm test && npm run test:coverage \
  && npm run dead-code && npm run build \
  && npm run test:browser:live          # live Chrome with STEALTH_ENABLED to validate
```
- Live validation: run `test:browser:live` against `bot.sannysoft.com` / `tls.peet.ws` with
  `STEALTH_ENABLED=true` and assert the expected signals flip green (webdriver hidden, UA coherent,
  no `HeadlessChrome` token). Keep a no-stealth run to prove default is unchanged.

---

## 13. Risk & Responsible-Use Guardrails

- **Opt-in by default** (mirrors `allowEval`): the distributed "trafficking" exposure noted in the
  legal research is mitigated because bypass/stealth ships OFF and requires explicit user config.
- **Prominent notices** in docs + `server_health`; dual-use disclaimer ("user responsible for ToS/laws").
- **Human-in-the-loop default** for hard/score-based captchas; solver is a fallback, not a replacement.
- **Proxy transparency**: if a proxy is configured, log its ASN/country (redacted PII); don't hide
  datacenter origin deceptively.
- **Politeness defaults**: respect `robots.txt` where feasible; rate-limit defaults; bounded requests.
- **Audit logging**: log solver invocations (provider, kind, outcome) with secrets redacted.
- **Legal posture** (from legal research): stealth for testing/own-sites/QA is the legitimate core;
  the tool stays neutral — the *operator* owns ToS/laws compliance. DMCA § 1201 exposure is
  minimized by opt-in + notices + HITL default.

---

## 14. Phased Rollout (sequencing)

1. **P1 — Baseline stealth** (Plan Phase 1): `headless:true` (coerced option) + `AutomationControlled` + lang/window.
   Lowest risk, highest reward. Ship first; measure captcha pass-rate.
2. **P2 — JS fingerprint bundle** (Phase 2): `balanced` profile, coherence-gated.
3. **P3 — CAPTCHA workflow**: improve HITL + `browser_challenge` fields; solver behind flag.
4. **P4 — Behavioral realism** (Plan Phase 3): opt-in `ghost-cursor` wrapper on click/input/scroll.
5. **P5 — Docs, tests, live validation, contract re-lock.**

(`P#` = rollout order; `Phase N` = plan chapter. They intentionally differ: CAPTCHA HITL ships before behavioral realism.)

Measure before/after on the 14/100 failing set at each phase; stop/scope if a phase degrades
performance (each phase is independently toggleable so regressions are isolated).

---

## 15. Validation Findings (2 review agents)

Two validation agents cross-checked the plan against the real code and the Puppeteer-core 25 API.
Their reports are saved as `STEALTH-CAPTCHA-REVIEW.md` (technical) and embedded in their sessions
(codebase). **Corrections already folded into this plan:**

| # | Finding | Correction applied |
|---|---|---|
| 1 | `page.addScriptToEvaluateOnNewDocument(source)` does not exist in v25 | Use `page.evaluateOnNewDocument(sourceString)` (Phase 2). |
| 2 | `headless:'new'` is an invalid type (`boolean \| 'shell'`); `headless:true` = new headless; `defaultArgs` already emits `--headless=new` | Drop `--headless=new` arg; coerce via the `headless` option (Phase 1). |
| 3 | `bypassAttempted` literal lives in `challenges.ts:34`, not `contracts.ts` | Fixed §8 attribution; widening is low-risk and tests survive. |
| 4 | Connect/ws/url modes bypass launch | Baseline launch-arg scope limited to `managed`/`launch`; connect gets JS+behavior layers only (Phase 1/8). |
| 5 | `research.ts` uses raw `fetch`, not a browser | Removed the "stealth baseline on DDG" claim; only optional polite headers (Phase 8). |
| 6 | `evaluateOnNewDocument` is per-page; new tabs/popups bypass | Funnel all pages through one injection point with a `stealthInjected` one-shot guard (Phase 2). |
| 7 | Solver token field differs per challenge; 2Captcha GET polling; CapSolver REST | Added per-kind field mapping + provider polling details (Phase 6.4). |
| 8 | Solver re-fire must coordinate with Fetch guard + `challengeActive` | Added coordination + fresh-snapshot re-detect requirement (Phase 6.4). |
| 9 | `Runtime.enable` CDP tell is mostly Playwright/patchright | Defer raw CDP scrubbing to a research spike; do not make it Phase 2 (Phase 5 note). |
| 10 | `ghost-cursor` is the mature de-facto-standard | Use it as a feature-flagged dependency instead of hand-rolling (Phase 3). |
| 11 | Contract SHA-256 lock + `verify-package.mjs` hygiene | Re-lock SHA; ensure new files introduce no forbidden refs; update `.env.example` (§10/§11). |
| 12 | Removed-switch guards (config.ts:470–479) | Kept with distinct-named master switch `SMOOTH_OPERATOR_STEALTH_ENABLED` (§9). |
| 13 | **PLAN self-contradiction**: §14 listed `--headless=new` as a shipped flag vs §3/§15 (drop it) | Fixed §14 → `headless:true` (coerced option); clarified P# (rollout) vs Phase# (chapter) mapping. |
| 14 | **§6.2 overclaim**: "most score-based challenges pass via baseline+behavior" | Tempered to "a meaningful fraction *when paired with a clean/residential IP + warm session*" (aligns with bot-detection research). |
| 15 | **Redundant flag**: `--disable-background-networking` in `STEALTH_BASELINE_ARGS` | Removed (already in `NATIVE_BROWSER_LAUNCH_ARGS`); stealth args kept as a separate builder so the default-args test stays clean. |
| 16 | **Provider naming divergence**: `9captcha` (plan) vs `anticaptcha` (research) | Standardized on `anticaptcha` (9captcha.com is Anti-Captcha's newer domain); documented the bundled `SolveResult` interface. |
| 17 | **Env-var naming divergence** (PLAN `CAPTCHA_SOLVER_*` vs research `SOLVER_*`) | PLAN names authoritative everywhere; research skeleton noted as inconsistent. |
| 18 | `evaluateOnNewDocument` not locally verifiable (`node_modules` absent) | Primary API = `evaluateOnNewDocument`; fallback `addScriptToEvaluateOnNewDocument` if the installed stub lacks it — confirm with `tsc`. |

**Remaining open decisions (for the implementer):**
- Whether `ghost-cursor` is an accepted runtime dep (verify-package `files` allowlist + `npm audit`).
- Exact `STEALTH_PROFILE` patch set for `max` (coherence-gated; see `STEALTH-RESEARCH.md` / `STEALTH_RESEARCH_REPORT.md`).
- Confirm `contract-snapshot.test.ts` exists and its SHA routine (for the §10 re-lock).

---

*Plan v3. Drafted from 6 research agents (codebase map + stealth, CAPTCHA, bot-detection,
libraries, legal/ethical), then hardened by TWO validation passes: (1) cross-file consistency +
technical accuracy of every feature `.md`, and (2) integration readiness against the real source
and Puppeteer-core 25 API. All findings from both passes are folded in above.*
