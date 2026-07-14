# AGENTS.md

## Project Overview

Open Cowork is an open-source agentic browser-control Chrome extension (MV3). It uses a Planner + Navigator multi-agent architecture to autonomously read, reason, and act on web pages. The extension is fully self-contained — it calls LLM providers directly via `fetch`, no server or localhost backend required. An optional Next.js Cockpit dashboard provides real-time observability.

## Tech Stack

- **Language**: TypeScript 5 (strict)
- **Runtime**: Node.js ≥20.9.0 (required by Next.js 16), npm
- **Browser**: Chrome 116+
- **Extension bundling**: esbuild (ESM + code-splitting, bundles `src/extension/` → `chrome-extension/`)
- **Extension persistence**: `chrome.storage.local` (API keys, settings, run history) + `chrome.storage.session` (secrets — cleared on browser close)
- **Cockpit persistence**: Prisma ORM + SQLite (`cockpit/prisma/schema.prisma`, 22 models)
- **Schema validation**: Zod v4
- **State**: In-memory (extension service worker) + Prisma/SQLite (cockpit)

## Design System

- **Palette**: Signal Indigo on deep-ink — `#14161C` (void) → `#1C1F27` (surface) → `#232732` (raised) with `#6C5CE7` (signal indigo) accent. Semantic: muted green (success), muted warm red (error), violet (planner), sky blue (navigator/step), teal (observe).
- **Typography**: System mono (`ui-monospace, SF Mono, Menlo, Consolas`) for telemetry/data in the extension; JetBrains Mono in the cockpit (loaded via `next/font/google`). System sans for body text in both.
- **Signature element**: Monospace activity log in the side panel — color-coded rows (step/observe/reason/act/ok/err/info) with a live pulsing dot indicator. (No step-rail timeline — the log is a flat timestamped list.)
- **Dark-first**: Both the extension and cockpit are designed dark-first, with light variants via `prefers-color-scheme`.
- **Cockpit utilities**: `.cowork-mono`, `.cowork-eyebrow`, `.cowork-grid-bg`, `.cowork-scroll`, `.tnum`, `.cowork-pulse` (in `cockpit/src/app/globals.css`).

## Architecture

```
src/lib/                   Shared library root
  validations.ts            Shared validators (MAX_ACTIONS, MAX_ELEMENTS_CHARS, …)
src/lib/agent/              Core agentic engine (framework-agnostic TypeScript)
  types.ts                  Type definitions + configuration
  security.ts               Prompt-injection defense (10 detectors + 28 redaction patterns) + domain restrictions
  errors.ts                 Typed error taxonomy (12 ErrorCategory values, 22 AgentError subclasses)
  callbacks.ts              15-hook callback system
  judge.ts                  Post-hoc LLM evaluation of task completion
  domain-skills.ts          Per-site instruction packs (7 built-in: GitHub, Gmail, Amazon, Google, Twitter/X, LinkedIn, Reddit)
  modes.ts                  Restricted / Standard / Full Agentic modes
  secrets.ts                %var% secret substitution (secrets never reach the LLM)
  human-interaction.ts      Human-interaction tool (ask user mid-run)
  run-history.ts            Run persistence + transcript replay
  scheduled-tasks.ts        chrome.alarms scheduling + chrome.power.requestKeepAwake
  output-parser.ts          Zod-validated JSON parsing (tolerant of model variation)
  anti-detection.ts         13 anti-detection patches (webdriver, plugins, WebGL, …)
  anti-bot.ts               Anti-bot challenge detection (Cloudflare, hCaptcha, reCAPTCHA)
  cdp-controller.ts         CDP-level pixel-perfect control (try/finally — always detaches)
  persistent-memory.ts      Per-site memory across sessions
  html-summarizer.ts        HTML → text summarization
  runtime.ts                Runtime context
  llm/                      LLM provider layer (4-layer architecture, 16 providers)
    provider.ts             LLMProvider interface + registry
    provider-bridge.ts      Shared toLLMProvider bridge
    pricing.ts              Live catalog-backed pricing (models.dev/api.json via catalog.ts; no static table)
    retry.ts                Shared retry with exponential backoff (429/5xx/network, abort-aware)
    catalog.ts              models.dev live catalog fetcher + cache (5-min TTL, per-model vision detection)
    route/                  Composable route layer (auth, endpoint, transport, framing)
      auth.ts               Composable auth chain: optional(key).orElse(config(env)).bearer()
      endpoint.ts           Endpoint builder (baseURL + path + query)
      framing.ts            SSE + JSON-line framing
      transport-http.ts     HTTP transport (fetch + stream reader, 30s per-chunk timeout)
      client.ts             Route factory: make({protocol, endpoint, auth, framing})
    protocols/              API format implementations (provider-agnostic)
      openai-chat.ts        /chat/completions format (OpenAI, Azure)
      openai-compatible-chat.ts  Same + frequency_penalty (DeepSeek, Groq, Ollama, etc.)
      anthropic-messages.ts /v1/messages format (system extraction, vision, tool_use, caching)
      gemini.ts             :generateContent format (vision, responseSchema)
    providers/              Thin provider facades (pick a protocol, configure auth + endpoint)
      openai.ts             OpenAI (bearer auth, OPENAI_API_KEY)
      anthropic.ts          Anthropic (x-api-key, ANTHROPIC_API_KEY, prompt caching)
      google.ts             Google Gemini (x-goog-api-key, per-model URL path)
      xai.ts                xAI Grok (bearer, OpenAI-compatible)
      azure.ts              Azure OpenAI (api-key header, resourceName → baseURL)
      openrouter.ts         OpenRouter (bearer, 300+ models)
      openai-compatible.ts  Generic factory
      openai-compatible-profile.ts  14 profiles: baseten, cerebras, deepinfra, deepseek, fireworks, groq, qwen, mistral, openrouter, together, xai, ollama, opencode, litellm
  loop/                     Agent loop
    orchestrator.ts         Planner + Navigator coordination loop (the core engine)
    loop-detector.ts        20-element rolling-window action repetition detector (LOOP_WINDOW_SIZE = 20)
    messages.ts             Message builder (single source of truth for navigator + planner)
    compaction.ts           Context compaction (summarize old history)
    constants.ts, types.ts, early-stop.ts, helpers.ts (barrel re-export of helpers/)
    phases/                 Loop phase implementations (observe-state, planner-phases, navigator)
    helpers/                action-queue, compaction-runner, judges, llm-calls, state-helpers, takeover
    context/                Context injection points
  tools/                    Action system (32 actions)
    schema.ts               Zod schemas for 32 actions + ACTION_METADATA + actionListForPrompt
    executor.ts             Action execution with page-change detection + Set-of-Marks
    registry.ts             Dynamic tool registration + custom tool plugins
    describe.ts, constants.ts
    handlers/               28 action handler files (click, input, scroll, navigate, evaluate, …)
    helpers/                DOM fingerprint, domain config, element resolver, key parser, select helper
  prompts/                  System prompts
    navigator-prompt.ts     Navigator system prompt (role, rules, error recovery, examples)
    planner-prompt.ts       Planner system prompt (decompose, verify, done)
  dom/                      DOM interaction
    extraction/             Page state extraction (ax-tree-builder, element-info, page-state)
    annotation/             Set-of-Marks + overlay (screenshot-annotator, overlay-renderer, shadow-piercer)
    navigation/             JS-dialog handler (popup-handler)
    interaction/            Hover + phantom cursor (hover.ts)
    utils/                  classification, visibility, tree-walker, selectors
    ax-tree.ts, extractor.ts, overlay.ts, phantom-cursor.ts, …  Re-export shims (backwards-compat for legacy import paths)
  evaluators/               html-content, string, url evaluators

src/extension/              Chrome extension (bundled via esbuild)
  manifest.json             MV3 manifest (host_permissions: http://*/* + https://*/*, NOT <all_urls>)
  background.ts             esbuild entry shim → background/index.ts
  background/               Service worker logic
    index.ts                onMessage router + onConnect keepalive port + alarms
    agent-bridge.ts         Agent loop runner + screenshot/vision wiring + SW keepalive port
    message-routing.ts      CDP clicks (try/finally), save_as_pdf, screenshot handlers
    state-store.ts          chrome.storage.session state + 15s keepalive alarm
    tab-manager.ts          Screenshot capture (cached quality) + tab management
    task-queue.ts           Run queue
  content.ts                Content script (DOM + AX-tree + actions + element rects)
  llm-direct.ts             Direct LLM calls (navigator + planner, no localhost)
  provider-config.ts        Builds LLMProvider from chrome.storage config (async, patches supportsVision per-model)
  provider-config-map.ts    Provider ID → models.dev catalog ID mapping
  shared.ts                 $, escapeHtml, DEFAULT_COCKPIT_URL, COCKPIT_URL_STORAGE_KEY, getCockpitUrl()
  sidepanel.html + .css     Side panel UI (signal indigo on deep-ink, instrument-stack layout, flat timestamped log)
  sidepanel.ts              esbuild entry → sidepanel/index.ts
  sidepanel/                Side panel modules
    index.ts                Init + message listeners + chrome.runtime.connect keepalive port
    controls.ts             Run/pause/stop/mode/preset handlers
    lifecycle.ts            Status, progress, cost, step labels
    log-renderer.ts         Activity log + thinking panel rendering (escapeHtml on all dynamic content)
    takeover.ts             Takeover banner show/resume
    human-interact.ts       ask-human modal + password prompt
  options.html + .css      Settings page (left sidebar rail, 10 tabs, indigo active indicator)
  options.ts                esbuild entry → options/index.ts
  options/                  Options modules (10 tabs)
    index.ts                Tab switching + save/load
    provider-config-ui.ts   Provider dropdown + model search (models.dev catalog)
    settings-sync.ts        Secrets (escapeHtml), domains, behavior, cockpit URL
    scheduled-tasks.ts      chrome.alarms CRUD + chrome.power.requestKeepAwake
    custom-tools.ts         Custom JS tool CRUD
    skills.ts               Domain skill CRUD
    history.ts              Run history list + export/import
    prompts.ts              Navigator/planner prompt overrides
    notifications.ts        Completion notifications + webhook
    vision-status.ts        Local Vision Assistant status badge + progress
  vision-assistant/         Local Vision Assistant (LocateAnything-3B via WebGPU, lazy-loaded, 2.1 GB INT4)
    index.ts                Public API + onStatus/onProgress callbacks
    inference.ts            ONNX Runtime Web inference (INT4 + 4-bit embeddings)
    model-loader.ts         2.1 GB model download in 48 MB chunks (Cache Storage API, retry)
    preprocessor.ts         Image → tensor (MoonViT preprocessing)
    embedding-gather.ts     Text embedding gather
    box-parser.ts           Detection box parsing (<ref>label</ref><box>x1,y1,x2,y2</box>)
    merger.ts               Merge vision + DOM elements
    constants.ts            Model URLs (MODEL_REPO_URL + MODEL_BASE_URL), token IDs, architecture
    types.ts                Vision types

tests/                      Vitest test suite (778 test() calls across 42 files)

cockpit/                    Next.js 16 dashboard (read + create + delete over Prisma/SQLite — includes POST create and DELETE erase endpoints for history, form memory, site memory, and chat)
  prisma/schema.prisma      SQLite schema (22 models: Tab, Workspace, Session, Task, AgentTrust, SecurityEvent, …)
  src/
    middleware.ts           Auth middleware — X-Cowork-Token on /api/cowork/* (except 5 public discovery routes), constant-time token comparison, fail-closed in production with dev-token
    app/
      layout.tsx            Root layout (Geist fonts + ThemeProvider + Toaster)
      page.tsx              Renders <CoworkShell/>
      globals.css           Tailwind 4 + OKLCH theme tokens + .cowork-mono/.cowork-eyebrow/.cowork-grid-bg/.cowork-scroll/.tnum/.cowork-pulse
      api/cowork/           24 REST routes (tabs, workspaces, sessions, agents, workflows, bookmarks, history, pinboards, extensions, security/events, memory/site, memory/form, mcp/tools, ai/chat, ai/image, events/emit, events/stream, …)
      api/cowork/agent/     External-agent discovery API (bootstrap, manifest, version) — public, no auth
    components/
      cowork/
        cowork-shell.tsx    Dashboard layout (min-h-screen flex flex-col, sticky footer, VIEWS map)
        providers.tsx       QueryClientProvider (30s staleTime)
        shared/             view-header, data-table, status-pill, empty-state, loading-skeleton
        views/              14 views (tabs, workspaces, sessions, agents, workflows, mcp, network, devtools, snapshots, memory, security, collections, extensions, chat)
      layout/               header (48px backdrop-blur), sidebar (220px amber active), footer, mobile-sidebar, nav-config (6 groups), theme-toggle, connection-status
      ui/                   14 shadcn/ui components (accordion, badge, button, card, dialog, dropdown-menu, input, progress, select, sheet, skeleton, tabs, toast, toaster)
    hooks/                  use-cowork-query (TanStack), use-cowork-store (Zustand), use-websocket (socket.io with X-Cowork-Token handshake auth), use-toast, use-mobile
    lib/
      db.ts                 Prisma client singleton (global cache for dev hot-reload)
      utils.ts              cn() (clsx + tailwind-merge)
      cowork/api/http.ts    json, badRequest, serverError, withRouteError, bodyJson
      cowork/api/agent-bootstrap.ts  AGENT_STARTUP_SEQUENCE markdown for external LLM agents
      cowork/events/client.ts        Server-to-server broadcast helper (POST /emit to mini-service)
      cowork-data/          types + format helpers (timeAgo, formatBytes, truncate)

mini-services/cowork-events/ WebSocket mini-service (port 3003, bound to 127.0.0.1)
  index.ts                  socket.io server + REST routes (/emit, /chat, /image, /events, /health)
                            Security: 127.0.0.1 bind, X-Cowork-Token on all routes, constant-time token comparison,
                            refuses dev-token in production, socket.io handshake auth, CORS allowlist
  README.md                 Endpoint + channel docs

.github/
  workflows/ci.yml          npm (Node 20) — lint, test, build:extension, sync-check; cockpit: db:generate, tsc, lint, build
  dependabot.yml            Weekly npm + github-actions dep bumps (grouped)

docs/safety.md              12 trust-boundary rules for untrusted page content
SECURITY.md                 Trust hierarchy, code vs prompt-only enforcement, evaluate risk, retention
CONTRIBUTING.md             Dev workflow + build commands (npm)
CHANGELOG.md                Release notes
```

## Build Commands

All scripts use npm. A single `npm install && npm run dev` bootstraps and starts everything.

- `npm run dev` — Start extension watch-build + cockpit + events together (via `concurrently`)
- `npm run dev:ext` — Extension watch-build only (esbuild `--watch`)
- `npm run dev:cockpit` — Next.js cockpit dev server on port 3000 (bound to `127.0.0.1`)
- `npm run dev:events` — cowork-events mini-service on port 3003 (`tsx watch`)
- `npm run lint` — ESLint (root)
- `npm run test` — Vitest suite (778 test() calls across 42 files)
- `npm run test:watch` — Vitest watch mode
- `npm run test:coverage` — Vitest with coverage
- `npm run build:extension` — esbuild → `chrome-extension/`
- `npm run build:cockpit` — `npm run db:generate && next build` in `cockpit/` (auto-generates Prisma client)
- `npm run build:all` — extension + cockpit (works on fresh clone, no separate prisma generate needed)
- `cd cockpit && npx tsc --noEmit` — type-check the cockpit
- `cd cockpit && npm run lint` — ESLint (cockpit)

The `postinstall` hook auto-installs `cockpit/` and `mini-services/cowork-events/` sub-package dependencies. Cockpit's install runs Prisma's own postinstall (engine download) so `db:generate` works locally; `build:cockpit` still runs `db:generate` explicitly.

## Agent Loop

1. **Planner** decomposes the task into a step-by-step plan
2. **Navigator** observes the page (DOM + AX-tree + annotated screenshot), reasons via LLM, and acts
3. Actions execute with page-change guards (abort remaining queue if page changes)
4. Every 5 navigator steps, the **Planner** re-evaluates progress and updates the plan
5. Only the Planner can call `done(success=true)` — the Navigator's `done` triggers Planner verification
6. After `done(success=true)`, the **Judge** optionally verifies completion independently
7. Loop continues until `done` or max steps reached (default 100, max 500)

## Agent Capabilities (32 actions)

`click, input, select_dropdown, scroll, send_keys, navigate, switch_tab, close_tab, go_back, wait, find_text, extract, done, search, upload_file, screenshot, save_as_pdf, dropdown_options, search_page, find_elements, evaluate, hover, press_and_hold, ask_human, load_skill, takeover, verify, alert_accept, alert_dismiss, alert_get_text, alert_send_keys, detect_visual`

## Key Design Decisions

- **Self-contained extension**: The extension calls LLM providers directly via `fetch` — no server, no `.env`, no localhost. Chrome's `host_permissions: ["http://*/*", "https://*/*"]` grants cross-origin access (narrower than `<all_urls>` — blocks `file://` and `data:` injection by design).
- **4-layer LLM architecture**: route (auth/transport) → protocols (API format) → providers (thin facades) → LLMProvider bridge. Adding a provider = 1 line in the profiles table.
- **ESM + code-splitting**: esbuild uses `format: "esm"` + `splitting: true` so the 2.6 MB vision stack lazy-loads as a separate chunk. `background.js` is 9.3 KB (was 3.9 MB under IIFE). Zod's 50+ locale files are stubbed to `en` only.
- **Service-worker keepalive**: Side panel opens a long-lived `chrome.runtime.connect({ name: "keepalive" })` port. Chrome keeps the SW alive while the port is open, preventing mid-LLM-stream termination. The 15s `chrome.alarms` keepalive stays as a fallback for when the side panel is closed.
- **Dual-channel page state**: DOM tree (`[index]<tag>`) + accessibility tree (`ref_NNN`) + annotated screenshot (Set-of-Marks with numbered labels, JPEG q=85)
- **Per-model vision detection**: `modelSupportsVision()` checks the models.dev catalog's `attachment` field + heuristic name-based fallback. `buildProvider()` is async, patches `supportsVision` per-model.
- **Frontmatter-first skills**: Only skill name + description in context (~10 tokens/skill). Full body loaded on-demand via `load_skill` action.
- **Injection classifier**: 10 `INJECTION_DETECTORS` across 6 labels (ignore-previous-instructions, role-impersonation, role-tag-impersonation, premature-done, tag-injection, new-instructions-preamble) + 27 `INJECTION_PATTERN_SOURCES` for redaction. Non-destructive — flags but doesn't redact (the redaction layer handles that).
- **Error taxonomy**: 12 `ErrorCategory` values (auth, forbidden, bad_request, rate_limit, server_error, network, cancelled, parse, max_steps, max_failures, programmer_error, unknown) and 22 typed `AgentError` subclasses
- **Mode enforcement**: Every action checked against restricted/standard/full_agentic mode before execution. `evaluate` requires `full_agentic`.
- **Secret substitution**: `%varName%` placeholders substituted at execution time — the LLM never sees real values
- **Takeover mode**: Agent can pause for sensitive actions (login, payment, captcha) and let the user act manually
- **Persistent per-site memory**: User-defined notes per domain, injected as trusted context
- **Custom tool plugins**: Users define JS tools in Options; agent invokes via `evaluate`
- **Local Vision Assistant**: LocateAnything-3B (NVIDIA's original model, Reza2kn's ONNX INT4 WebGPU port) runs entirely in-browser via WebGPU. 2.1 GB one-time download, cached in Cache Storage API. Fire-and-forget init — doesn't block the first agent step.
- **Cockpit auth**: `cockpit/src/middleware.ts` requires `X-Cowork-Token` on all `/api/cowork/*` routes except 5 public discovery endpoints (`agent/bootstrap`, `agent/manifest`, `agent`, `agent/version`, `skill`). Uses `constant-time token comparison`, fail-closed in production with `dev-token`.
- **Mini-service hardening**: Bound to `127.0.0.1` (not `0.0.0.0`), `constant-time token comparison` token comparison, refuses `dev-token` in production, socket.io handshake auth, CORS allowlist.

## Testing

Run `npm run test` to execute the Vitest test suite (778 test() calls across 42 files):

- `tests/unit.test.ts` — Output parser, loop detector, pricing, compaction, secrets, schema coercion
- `tests/security.test.ts` — Sanitization, injection classifier, domain allowlist, error taxonomy, mode enforcement, secret-leak prevention
- `tests/ax-tree.test.ts` — Role detection, sensitive fields, output format, element map
- `tests/ax-tree-dom.test.ts` — AX-tree DOM classification (shared helpers)
- `tests/modules.test.ts` — Callbacks, domain skills (frontmatter + full body), modes, error classification
- `tests/executor.test.ts` — Action description + execution behavior
- `tests/executor-actions.test.ts` — 32-action executor coverage (click fallback, popup-handler, dropdown, …)
- `tests/extractor.test.ts` — DOM extraction, element hashing, visibility filtering
- `tests/integration.test.ts` — Stream parsing, message builders (with skills + injection warnings + memory + custom tools), navigation-waiter
- `tests/schema-sync.test.ts` — Action schema ↔ ACTION_METADATA ↔ AgentAction type sync
- `tests/llm-protocols.test.ts` — LLM protocol body construction + stream-frame parsing
- `tests/confirmation-gate.test.ts` — Confirmation gate wiring + ask_human invocation
- `tests/extension-modules.test.ts` — Extension background + sidepanel + options wiring
- `tests/orchestrator-logic.test.ts` — Planner + Navigator loop phases + takeover resume
- `tests/judge-retry.test.ts` — Judge LLM call + retry on transient errors
- `tests/stateful-modules.test.ts` — Secrets, persistent memory, custom tools (stateful)
- `tests/agent-loop-memory.test.ts` — Compacted-memory injection + navigator context shaping
- `tests/dom-extraction-enhancements.test.ts` — SoM annotator, navigation waiter, overlay
- `tests/modules-helpers.test.ts` — Registry format instructions, dom-utils locators (`By`/`RelativeBy`/`findByLocator`), navigation-waiter conditions, typed errors + encode/decode, executor click fallback + popup-handler queueing
- `tests/wiring-fixes.test.ts` — Cross-module wiring (CDP press-and-hold, search, etc.)
- `tests/cowork-events.test.ts` — Mini-service HTTP routes + pure security primitives (`tokenMatches`, `applyCorsHeaders`, `shouldRefuseStart`): auth gating, CORS allowlist, /emit broadcast, /events replay, 401 vs 200 boundary
