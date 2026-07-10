# Changelog

All notable changes to Open Cowork will be documented in this file.

## [Unreleased]

_No changes yet._

## [0.3.1] — Terracotta on Warm Charcoal UI Redesign + repository hygiene

### Repository Hygiene
- **Committed 3.3 MB of build artifacts**: The `chrome-extension/chunks/`
  directory (38 files, 3.3 MB — including the 2.1 MB `transformers.web` vision
  stack and 520 KB `vision-assistant` chunk) was committed to git. This happened
  because the Phase 4 esbuild ESM + code-splitting change created the `chunks/`
  directory, but the `.gitignore` only listed the 4 old IIFE entry files.
  Fixed: `.gitignore` now covers `chrome-extension/*.js` + `chrome-extension/chunks/`.
  The 38 chunk files are `git rm --cached`'d (still built locally, just not tracked).
  Static source-of-truth files (`manifest.json`, `*.html`, `*.css`, `icons/`) remain
  tracked — the CI sync-check still verifies they match `src/extension/`.
- **Cockpit lint warnings reduced**: 13 → 0 (all warnings cleared).
  Removed 3 unused imports introduced by the UI redesign: `X` from `agents-view.tsx`,
  `EmptyState` from `network-view.tsx`, `React` from `nav-config.tsx`. Subsequent
  the cockpit now lints
  clean under `next lint`.

### Visual Identity
- **Design system: Terracotta on Warm Charcoal** — dark-first palette
  (`#262624` void → `#30302E` surface → `#353330` raised) with a terracotta
  (`#D97757`) accent. Semantic colors: muted green (success), muted warm red
  (error), violet (planner), sky blue (navigator/step), teal (observe). System
  mono for telemetry/data in the extension; JetBrains Mono in the cockpit.
- **Signature element: Monospace activity log** in the side panel — color-coded
  rows (step/observe/reason/act/ok/err/info) with a live pulsing dot indicator.
  Flat timestamped list (no step-rail timeline).
- **Extension side panel**: Instrument-stack layout, hexagon brand mark, dark-first.
- **Extension options page**: Left sidebar rail (150px) replacing horizontal
  tabs, amber active indicator.
- **Cockpit dashboard**: OKLCH tokens, `.cowork-mono` / `.cowork-eyebrow` /
  `.cowork-grid-bg` utilities, compact 220px sidebar with amber active borders,
  48px header with backdrop blur, 3 exemplar views (Tabs, Network, Security).

## [0.3.0] — 2025-07-05

A single consolidated release note for 0.3.0. Earlier drafts had four
`## [0.3.0]` sections (npm migration, cockpit cleanup,
and the dated 2025-07-05 list); they've been merged here in chronological
order with logical subsections.

### Security
- **Cockpit API authentication**: Added `cockpit/src/middleware.ts` requiring
  `X-Cowork-Token` header on all `/api/cowork/*` routes (except 5 public
  agent-discovery endpoints). Fail-closed in production with `dev-token`.
- **Mini-service hardening**: Bound to `127.0.0.1` (was `0.0.0.0`); constant-time
  token comparison via `crypto.timingSafeEqual`; refuses `dev-token` in
  production; requires `X-Cowork-Token` on all REST routes.
- **Socket.io auth**: Token required in `handshake.auth` on every connection;
  unauthenticated sockets are disconnected immediately. CORS restricted to
  `COWORK_CORS_ORIGIN` (default `http://localhost:3000`).
- **Host-header injection fixed**: Cockpit `agent/{bootstrap,manifest,route}`
  routes now use `process.env.COWORK_BASE_URL` instead of the request `Host`
  header.
- **SSE CORS removed**: `Access-Control-Allow-Origin: '*'` removed from the
  cockpit events/stream route (same-origin dashboard doesn't need CORS).
- **Manifest permissions narrowed**: `host_permissions` changed from
  `<all_urls>` to `http://*/*` + `https://*/*` (blocks `file://` injection).
- **CDP debugger leak fixed**: `CDP_CLICK` and `CDP_PRESS_AND_HOLD` now use
  `try/finally` to guarantee `detachDebugger` runs on all paths.
- **Secret name XSS fixed**: `escapeHtml()` applied to secret name rendering
  in `settings-sync.ts`.
- **Filename sanitization strengthened**: `save_as_pdf` / `screenshot` now
  sanitize `fileName` with `[^\w.-]+ → _` and cap to 120 chars.
- **`evaluate` risk documented**: SECURITY.md now explicitly warns that
  `evaluate` in `full_agentic` mode can exfiltrate API keys from
  `chrome.storage` via the content-script isolated world.
- Wired the confirmation gate into the orchestrator; fixed `ask_human`
  to actually call `askHuman()` instead of fabricating a response.
- Domain allow/blocklist now enforced in the extension's
  tab-level handler (was dead code); domain config UI added to Options.
- Secret values no longer leak into LLM context or persisted run
  history (executor redacts + `saveRun` calls `redactSecrets()`).
- Fixed secrets storage split-brain — Options UI now uses
  `secrets.ts` functions (was writing to `chrome.storage.local` while runtime
  read from `chrome.storage.session`).
- `evaluate` action now gated by domain allow/blocklist.
- `escapeHtml` applied to third-party catalog data in Options model
  search.
- Consolidated confirmation lists into single source of truth.

### Reliability
- Fixed streaming truncation — `terminal()` now checks parsed
  `finish_reason` value, not key presence (affected all OpenAI-format
  providers).
- Scheduled tasks alarm listener added to `background.ts` (feature
  was completely non-functional).
- `runEnd` callback now reports the actual success/failure outcome
  (was hardcoded `false`).
- Stream-client timeout routes through `onError` instead of
  synthesizing `onDone`.

### Performance
- **background.js bundle: 3.9 MB → 8.3 KB** (99.8% reduction). Switched
  esbuild from IIFE to ESM + code-splitting. The 2.6 MB vision stack
  (`@huggingface/transformers` + `onnxruntime-web`) now lazy-loads as a
  separate chunk only when Local Vision is enabled. Zod's 50+ locale files
  stubbed to `en` only (saves ~600 KB).
- **Service-worker keepalive port**: Side panel opens a long-lived
  `chrome.runtime.connect({ name: "keepalive" })` port. Chrome keeps the SW
  alive while the port is open, preventing mid-LLM-stream termination.
  Existing `chrome.alarms` keepalive stays as a fallback.
- **DOM double-walk eliminated**: `EXECUTE_ACTIONS` now uses the cached
  `getSelectorMap()` instead of re-running `extractBrowserState([])`.
- **AX-tree O(N²) → O(N)**: Pre-builds a `Map<string, HTMLLabelElement>` of
  all `<label for>` elements once per extraction pass.
- **Screenshots: PNG → JPEG q=85**: 3-5× smaller, ~65 MB canvas allocation
  per step reduced.
- **Per-chunk SSE timeout**: 30s timeout on stalled LLM streams (was
  infinite hang). Retries via the existing `withLLMRetry` layer.
- **screenshotQuality cached**: Module-level cache, invalidated on
  `chrome.storage.onChanged`.
- Screenshots extracted into `image_url` content parts for
  OpenAI-format providers (was shipped as raw base64 text).
- Removed redundant retry layer (was 3 layers / 48x worst-case; now
  2 layers / 12x).
- Compacted-memory block now actually injected into the navigator
  prompt (was computed but discarded).
- AX tree generation made opt-in via `includeAxTree` flag.
- Regex complexity guard for `search_page` (pattern length cap +
  node visit cap).
- Module-level caching for skills, memories, and custom tools (was
  3 storage round-trips per step).

### Scheduled Tasks
- **Power management**: Added `power` permission to manifest. Scheduled-task
  alarm arming now calls `chrome.power.requestKeepAwake("system")` so the
  laptop doesn't sleep through pending alarms. The lock is released when the
  run completes OR when all scheduled tasks are disabled (whichever happens
  first). This bridges — but does not eliminate — the MV3 limitation that
  alarms only fire while Chrome is running.
- **Documentation**: README + Options → Schedule tab now explicitly document
  that scheduled tasks require Chrome to be running; closing Chrome or
  shutting down the computer will skip the alarm.

### Code Quality
- `case "search"` added to `handleTabAction` (was silently no-op
  in extension).
- Constants imported from `validations.ts` instead of re-declared.
- `computeNextFire` imported from `scheduled-tasks.ts` (was
  duplicated in `options.ts`).
- JSON extraction consolidated into shared `extractJson` helper.
- `_isBudgetHandler` added to `AsyncCallbackHandler` interface
  (was duck-typed).
- Dead `depth` parameter removed from `substituteCustomToolCalls`.
- Twitter/X domain skills merged using `domains: string[]` (was
  duplicate entries).
- Provider metadata imported from `openai-compatible-profile.ts`
  (was triplicated).
- **Removed dead `any` types**: `vision-status.ts`'s `visionAssistant: any`
  → `VisionAssistant | null` (typed via `import("../vision-assistant")`).
  `inference.ts`'s `executionProviders: [...] as any` → plain array
  (onnxruntime-common's `ExecutionProviderConfig` already includes `string`).
- **Removed dead utility functions**: `isVisionIndex` and `parseVisionIndex`
  in `vision-assistant/merger.ts` were exported but never imported elsewhere.
  Removed both + their re-exports from `vision-assistant/index.ts`.
- **De-duplicated `SEARCH_ENGINE_URLS`**: was duplicated in
  `lib/agent/tools/constants.ts` and `extension/background/tab-manager.ts`.
  The tab-manager now imports the canonical map from `constants.ts` (the
  stale cross-reference comment in `constants.ts` was also fixed).
- **Tsconfig scoping**: Root `tsconfig.json` now excludes `cockpit/`,
  `mini-services/`, and `chrome-extension/` — these have their own tsconfigs.
  This makes `npx tsc --noEmit` from the repo root type-check ONLY the
  extension's source tree (clean exit).
- **Deleted 16 dead barrel/module files** (~1.5k LOC): the entire
  `src/lib/agent/index.ts` public-API barrel tree (`types-branded.ts`,
  `errors/{index,codes}.ts`, `callbacks/{index,telemetry,screenshot-retention,budget}.ts`,
  `llm/providers/index.ts`, `loop/{phases,context}/index.ts`,
  `dom/index.ts`, `dom/{extraction,annotation,navigation,interaction}/index.ts`).
  Zero importers — all internal code imports submodules directly.
- **Removed `uuid` dependency**: Never imported (replaced by
  `crypto.randomUUID()` and `Date.now()`-based ID generation).
- **Deleted `cockpit/src/app/api/route.ts`**: create-next-app boilerplate.
- **Removed dead `notFound()` export** from `cockpit/src/lib/cowork/api/http.ts`.
- **AGENTS.md rewritten**: Architecture tree now matches the actual
  post-refactor layout (includes `loop/{phases,helpers,context}/`,
  `dom/{extraction,annotation,navigation,interaction,utils}/`,
  `tools/{handlers,helpers}/`, `extension/{background,options,sidepanel}/`,
  `vision-assistant/`, `cockpit/src/middleware.ts`). Error-taxonomy counts
  corrected (12 categories, 22 subclasses).
- **CONTRIBUTING.md fixed**: Removed false "Bun-only" / "Bun convenience
  wrapper" language; fixed broken markdown; added `npm install && npm run dev`
  one-command workflow.

### Cockpit + Config Cleanup
- **Removed the password vault entirely.** The `POST /api/cowork/passwords`
  route stored plaintext passwords into a column named `passwordEncrypted`
  because the referenced `src/lib/cowork/db/crypto.ts` module never existed.
  The route, Prisma `Password` model, `VaultView`, `usePasswords` hook, and
  `SamplePassword` type have all been deleted, along with the
  `COWORK_VAULT_KEY` env var. Do not re-add this feature without first
  implementing a real AES-256-GCM encryption layer.
- **Fixed the agent manifest to only declare endpoints that exist.** The
  previous manifest advertised ~120 endpoints; only 24 exist. ~96 declared
  endpoints returned 404. The manifest, `AGENT_STARTUP_SEQUENCE`,
  `AGENT_TOOLBOX`, and `AGENT_TOOL_SELECTION_HINTS` now reference only
  implemented routes.
- **Fixed 5 TypeScript compile errors** (`tsc --noEmit` now passes): duplicate
  `bootstrap` key in the manifest, undefined `entries` in `memory-view`, and
  wrong property names in `tabs-view`.
- **Removed fake UI interactions.** Tabs/Workspaces/Workflows/Sessions/
  Extensions/Collections/Agents views previously showed success toasts for
  actions that never happened (no API call, just `refetch()`). Buttons with no
  backing endpoint were removed; buttons with a real POST endpoint were wired
  to actual API calls.
- **Removed always-404 query hooks.** `useNetworkRequests`, `useConsoleLogs`,
  and `useSnapshot` referenced non-existent endpoints. The Network, DevTools,
  and Snapshots views now show an "Available in the extension only" state
  instead of always erroring. `useSessions` and `useExtensions` were corrected
  to hit the real `/sessions` and `/extensions` routes. `useApproveTask` and
  `useRejectTask` (which hit non-existent approve/reject endpoints) were
  removed along with their buttons.
- **Deleted dead cockpit modules:** `errors.ts`, `rate-limit.ts`,
  `injection-scanner.ts`, `error-state.tsx`. Removed dead exports
  (`header`, `query`, `queryInt`, `htmlResponse`) from `http.ts`.
- **Deleted `docs/blueprint/`** (23 files, 4.1 MB of extraction-plan research
  artifacts from 21 other open-source projects).
- **Strengthened ESLint config.** The cockpit and root ESLint configs
  previously disabled every meaningful rule (`no-unused-vars`, `prefer-const`,
  `no-fallthrough`, `no-dupe-keys`, etc.). The blanket disables were removed;
  the configs now catch real issues.
- **Fixed CONTRIBUTING.md.** Removed references to non-existent
  `test:unit` / `test:api` scripts and `tests/api.test.ts`. Corrected the dev
  command from `npm run dev` to `npm run dev:cockpit`.
- **Fixed CI.** The workflow now runs `tsc --noEmit` on the cockpit and
  removed `continue-on-error: true` from the lint step.

### Workflow / DX
- **One-command dev**: `npm install && npm run dev` starts extension
  watch-build + cockpit + events together via `concurrently` (cross-platform:
  Windows / Linux / macOS). `postinstall` auto-installs sub-package deps.
  `dev:ext` script added for extension-only watch.
- **Node engine bumped**: `>=18.18.0` → `>=20.9.0` (matches Next.js 16
  requirement). README prerequisite updated.
- **CI hardened**: Added `prisma generate` step before cockpit type-check.
- **.gitignore tightened**: `.env*` (ignore all env files) + `!.env.example`
  (whitelist the template). Prevents accidental `.env.production` commits.
- **Cockpit dev server bound to 127.0.0.1**: `next dev -H 127.0.0.1`
  (was default `0.0.0.0`).

### CSS
- **Orphan CSS classes fixed**: `.tool-add`, `.skill-add` added to the
  `.secret-add, .schedule-add` selector in `options.css`. `.tool-item` added
  to the `.secret-item, .schedule-item` selector. `.btn-pause` style added
  to `sidepanel.css` (amber-tinted, between run orange and stop red).
- **Pinboard card**: Removed misleading `cursor-pointer` class (card had no
  onClick handler).

### Documentation / Ops
- Removed stale Prisma/SQLite/Zustand claims from docs (cockpit now uses
  Prisma/SQLite; Zustand is a cockpit dep).
- Version sync (0.3.0 everywhere).
- CI workflow added (`.github/workflows/ci.yml`).
- `.env.example` added.
- Permissions documentation added to README.
- Security retention + scheduled-task docs added to SECURITY.md.
- Coverage tool (`@vitest/coverage-v8`) added.

### New Tests
- 133 new tests across 7 new test files (llm-protocols, confirmation-gate,
  extension-modules, orchestrator-logic, judge-retry, stateful-modules,
  executor-actions).
