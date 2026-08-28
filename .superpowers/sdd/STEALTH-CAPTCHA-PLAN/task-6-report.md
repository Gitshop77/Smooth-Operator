# Task 6 Report: `browser/solver.ts` — pluggable CAPTCHA solver with graceful fallback

## Status
DONE

## Commits
- `3d33b1f` feat(solver): pluggable CAPTCHA solver with graceful fallback (branch `smooth-operator-stealth`)

## What was implemented

New module `src/server/browser/solver.ts` — the HTTP-polling solver layer, fully
decoupled from the browser runtime (only global `fetch` + Node built-ins; no
Puppeteer). It produces solver objects; Task 10 wires `buildSolver` into
`service.ts`.

**Interface (exact, per brief + plan §6.4):**
- `SolveRequest`, `SolveResult`, `SolverProvider` exported.
- `buildSolver(config: Pick<ServerConfig, "captchaSolver">, logger?): SolverProvider | null`
  — returns `null` when provider is `none`, no `apiKey`, or unknown provider
  (graceful HITL fallback, never a hard failure). Optional 2nd `logger` param
  keeps the required one-arg signature and allows quiet logging in tests.
- `fieldSelectorForKind(kind)` exported — canonical token-field map:
  `gRecaptchaResponse` (recaptcha / recaptcha-enterprise), `cfTurnstileResponse`
  (cloudflare-turnstile / openai-turnstile), `hCaptchaResponse`
  (hcaptcha / hcaptcha-enterprise), `fc-token` (arkose), generic `captcha-response`
  fallback.

**Providers** (base class `HttpPollingProvider` owns shared request/bounded-read/
poll/wrap logic; subclasses supply task submission, polling, task-type map, and
kind coverage):
- `2Captcha` (`make2Captcha`): `POST in.php` + `GET res.php` polling. Distinguishes
  `status:1` (token), `status:0 && CAPCHA_NOT_READY` (keep polling), and
  `status:0` (refusal). Optional `callback` URL support (documented limitation:
  no webhook receiver in this module, so polling continues).
- `CapSolver` (`makeCapSolver`): `createTask` / `getTaskResult`, kind→task-type
  map (`ReCaptchaV2/V3TaskProxyLess`, `HCaptchaTaskProxyLess`,
  `CloudflareTurnstileTaskGeneral`, `FunCaptchaTaskProxyLess`, etc.).
- `Anti-Captcha` (`makeAntiCaptcha`): `createTask` / `getTaskResult`,
  kind→task-type map (`RecaptchaV2/V3TaskProxyless`, enterprise variants,
  `HCaptchaTaskProxyless`, `FriendlyCaptcha`, `AwsWaf`, `Altcha`).

**`supports(kind, scoreBased)`:** kind must be in the provider's set; a
score-based request against a non-score kind is a mismatch (returns false).
Score-capable kinds = recaptcha / recaptcha-enterprise / turnstile variants.

**Bounded + redacted (mandatory):**
- `readBoundedResponseText` streams the body and stops at `maxBytes` (never
  unbounded allocation), then trims to the same budget. Exported for direct test.
- `fetchJson` shared helper: bounded body, JSON decode, throws `SOLVER_REFUSED`
  on HTTP errors (5xx retryable).
- Returned token wrapped in `wrapUntrustedText("solver_token", …)`; provider
  refusal reasons run through `redactValue`. Logs only provider/kind/outcome/
  scoreBased — never apiKey/token/full responses.

**Timeouts + refusals (error contract):**
- Deadline (`createDeadline`) = `config.timeoutMs` (default 120s) + external
  `AbortSignal`. Poll loop bounded by deadline; fixed 5s poll interval, capped
  by remaining time.
- Deadline exceeded → `SOLVER_TIMEOUT` (retryable). Provider rejection / bad key
  / datacenter block → `SOLVER_REFUSED` with the surfaced reason. Abort →
  `CANCELLED`. A deadline that fires mid-submission is surfaced as
  `SOLVER_TIMEOUT` (not a raw abort DOMException).

## Tests (tests/solver.test.ts — 29 tests)
- `buildSolver`: null for `none` / unset apiKey / unknown provider; named provider
  when apiKey set; builds each of the three providers.
- `supports`: each provider true for documented kinds, false for unsupported
  (e.g. capsolver excludes friendlycaptcha/kaptcha; anticaptcha excludes
  turnstile/arkose; score-based-vs-non-score mismatch).
- `fieldSelectorForKind`: all canonical mappings + generic fallback.
- Bounded response: `readBoundedResponseText` caps an oversized body at maxBytes
  without throwing; returns full body within budget; `""` for body-less response.
- Timeout: polling `CAPCHA_NOT_READY` → `SOLVER_TIMEOUT` within bounded time
  (asserts elapsed < 5s); also times out when the submission request itself hangs.
- Refused: `{status:0, request:"ERROR_NO_KEY"}` → `SOLVER_REFUSED` carrying the
  reason; CapSolver task-level error surfaces `DATACENTER_IP_BLOCKED`.
- Never logs secrets / untrusted output: token is wrapped
  `<untrusted_solver_token>…</untrusted_solver_token>`.
- Extra: pre-solve abort → `CANCELLED`; missing pageurl → `SOLVER_INVALID`;
  CapSolver v3 action solve round-trip.

## Verification (TDD evidence)
- `npx vitest run tests/solver.test.ts` → **29 passed**.
- `npm run typecheck` (`tsc --noEmit`) → clean.
- `npm run lint` (`eslint .`) → clean.
- `npm run dead-code` (knip) → my exports all used; knip now reports only 2
  pre-existing findings (`ghost-cursor` dep, `SOLVER_UNAVAILABLE` export) — my
  module actually *resolved* 2 prior unused-export findings
  (`SOLVER_TIMEOUT`, `SOLVER_REFUSED`, now imported by this module).
- `npm run build` → clean.
- Full suite `npm test` → **379 passed, 1 failed**. The single failure is the
  pre-existing `tests/contract-snapshot.test.ts` stale-hash mismatch
  (`b1aa4339…` received vs committed `e84f39a…`). Verified identical on the clean
  baseline (stashed my two files): unrelated to this task (solver.ts does not
  touch the MCP public manifest; `mcp.ts`/`runtime.ts` don't import solver).

## Files changed
- `src/server/browser/solver.ts` (new, ~640 lines): factory, 3 providers, shared
  HTTP/polling/bounded/redacted core, token-field map, deadline handling.
- `tests/solver.test.ts` (new, 29 tests).

## Self-review findings
- **Surgical**: only the two requested files; no changes to surrounding modules.
  `buildSolver`'s signature matches the brief (optional logger param is
  backward-compatible). Exports are exactly what Task 10 needs plus the test seam.
- **Bug found and fixed during iteration**: `fetchJson` originally built the
  request as `{ ...init, signal }` where the explicit `signal` (4th param,
  `undefined` for 2Captcha, which passes the signal inside `init`) overwrote
  `init.signal` — making every 2Captcha request non-cancellable. Fixed to
  `signal: init?.signal ?? signal`. Caught via a signal-aware stub debug run
  (`signal present: false`). A real production correctness issue.
- **Correctness**: deadline vs external-abort distinction is handled at both the
  poll-loop level and the `solve()` catch level, so a mid-flight abort is mapped
  to the right error code. `CAPCHA_NOT_READY` is correctly treated as "keep
  polling", not a refusal.
- **Hygiene**: no forbidden phrases (`chrome extension`, `content script`,
  `model provider`, `service worker`, `embedded model/agent`, `native messaging`,
  `lightpanda`, `internal loop`, `src/extension`) in comments or code.

## Concerns
- **Pre-existing `contract-snapshot.test.ts` failure** (unrelated to Task 6): the
  committed snapshot hash `e84f39a…` is stale — prior stealth tasks added the
  `solve_challenge` action (Task 4, `fae8e93`) without refreshing the snapshot.
  Fails identically on the clean baseline. Left untouched per the surgical
  constraint; recommend refreshing the snapshot when the solver tool is registered
  (Task 10) or in a follow-up. Not blocking.
- **Pre-existing knip findings** (`ghost-cursor` unused dep, `SOLVER_UNAVAILABLE`
  unused export) existed before Task 6 and are independent of this module.
  `SOLVER_UNAVAILABLE` is intentionally unused here per the brief (the service
  handles the null case); Task 10's service wiring will consume it.
- **`callback` URL feature**: implemented per the brief ("Respect a configured
  callback URL; stops polling; documented") but this module has no webhook
  receiver, so polling continues regardless. The `callback` constructor param is
  threaded through but inert in practice. Not wired from config (the
  `captchaSolver` schema has no callback field), so it is dormant by default.
- **Fix (review finding): 2Captcha `fieldSelector` ignored the challenge kind.**
  `TwoCaptchaProvider.fieldSelector()` previously hardcoded
  `fieldSelectorForKind("recaptcha")`, so for every non-recaptcha kind 2Captcha
  actually solves (hcaptcha, hcaptcha-enterprise, cloudflare-turnstile,
  openai-turnstile, arkose — all present in its `kinds` set) the returned
  `fieldSelector`/`reFireEvent` were wrong (always `gRecaptchaResponse`). The
  base class already calls `this.fieldSelector(req.kind)` and the abstract
  signature is `fieldSelector(kind: ChallengeKind)`, so the fix simply threads
  the kind through:
  ```ts
  protected fieldSelector(kind: ChallengeKind): string {
    return fieldSelectorForKind(kind);
  }
  ```
  No other changes; `ChallengeKind` was already imported. CapSolver and
  AntiCaptcha already returned `fieldSelectorForKind(kind)` and were correct.

## Fix tests
Added an `it.each` covering test under the existing `2captcha solve lifecycle`
block that solves on 5 non-recaptcha kinds and asserts the per-kind token field
(and `reFireEvent`), closing the coverage gap the reviewer flagged:
- `hcaptcha` → `hCaptchaResponse`
- `hcaptcha-enterprise` → `hCaptchaResponse`
- `cloudflare-turnstile` → `cfTurnstileResponse`
- `openai-turnstile` → `cfTurnstileResponse`
- `arkose` → `fc-token`

Each uses the same `jsonFetchStub` in.php/res.php pattern as the existing
reCAPTCHA solve test.

## Verification (fix)
- `npx vitest run tests/solver.test.ts` → **34 passed** (29 + 5 from the new
  `it.each` cases).
- `npm run typecheck` (`tsc --noEmit`) → clean.
- `npm run lint` (`eslint .`) → clean.
- Full suite `npm test` → **384 passed, 1 failed** (the same pre-existing
  `contract-snapshot.test.ts` stale-hash failure, unrelated to this change).

## Files changed (fix)
- `src/server/browser/solver.ts` (+1/-1): 2Captcha `fieldSelector` override now
  accepts and forwards `kind`.
- `tests/solver.test.ts` (+21): `it.each` per-kind field coverage for 2Captcha.

## Self-review (fix)
- Surgical: exactly the finding's required one-line change plus the covering
  test; no restructuring, no new imports.
- The base class (`solve`) passes `req.kind` and the abstract contract already
  required `fieldSelector(kind)`, so threading the kind is type-correct and
  consistent with CapSolver/AntiCaptcha.
- Hygiene: no forbidden phrases introduced.

## Concerns
- None for this change. The remaining full-suite failure is the pre-existing,
  unrelated `contract-snapshot.test.ts` stale-hash (see top of this report).
- **Score-based token quality** is inherently limited (per CAPTCHA-RESEARCH-
  REPORT §6): solvers mint valid tokens that may score ~0.1; the site still
  decides allow/block. The module returns the token + field; injection policy
  remains with the service (Task 10). This is a documentation/honesty note, not a
  code defect.
