# AGENTS.md

## Project

Open Cowork — an agentic Chrome extension (Manifest V3) that reads pages, plans steps, and acts on them via an LLM. Two main code areas:

- `src/extension/` — extension code (background worker, side panel, options, vision assistant)
- `src/lib/agent/` — browser-independent agent engine (LLM routing, loop, tools, security)

Build output `chrome-extension/` is gitignored and regenerated on every build.

## Commands

| Command | What it does |
|---|---|
| `npm run build:extension` | Bundle extension into `chrome-extension/` |
| `npm run build:all` | Same as `build:extension` |
| `npm run dev` / `npm run dev:ext` | Watch-build for development |
| `npm run lint` | ESLint |
| `npm run test` | Vitest suite |
| `npm run test:coverage` | Vitest with coverage gate (pinned thresholds) |
| `npm run test:watch` | Vitest watch mode |

**Type-checking** has no npm script — CI runs `npx tsc --noEmit` directly. Running it locally: `npx tsc --noEmit`.

## Load the extension

Build first, then load `chrome-extension/` as an unpacked extension at `chrome://extensions` (Developer mode → Load unpacked).

## Key architecture notes

- **esbuild** bundles 5 entry points: `background.ts` (ESM, no splitting — MV3 SW can't use native `import()`), `content.ts`/`content-main.ts`/`sidepanel.ts`/`options.ts` (IIFE). `content-main.ts` is the MAIN-world shadow-piercer content script (declared as `world: "MAIN"` in the manifest).
- **esbuild.config.ts** has two special plugins: a zod-locales stub (strips 50+ locale files → `en` only, saves ~600 KB) and a console debug strip (production builds only, rewrites `console.debug/log` to `void`).
- `build-utils.ts` extracts testable helpers from the esbuild config so `tests/build-utils.test.ts` doesn't need to bundle the extension.
- Third-party licenses (`LICENSE-APACHE` for `@huggingface/transformers`, inline `LICENSE-MIT` for `onnxruntime-web`, `NOTICE`) are emitted by the build into `chrome-extension/` — see LIC-1 in `esbuild.config.ts`.
- **Path alias**: `@/*` → `./src/*` (tsconfig + vitest resolve alias).
- **`src/extension/manifest.json`** is the source of truth; it's copied to `chrome-extension/` by the build. Don't edit `chrome-extension/manifest.json` directly.
- The **model catalog** is sourced from the `@opencode-ai/models` SDK's snapshot entrypoint, which contains **173+ providers** with thousands of models. Updated automatically via `npm update`.
- **Context-adaptive budgets** (`src/lib/agent/prompts/prompt-token-budget.ts`): `deriveNavigatorObservationCapsV1` sizes the per-step observation (elements text / AX tree / screenshot) against the model's effective context. Unknown/≥128k models get the fixed 128k defaults; sub-128k models get a fitting allocation using the COMPACT system prompt overhead. The effective context flows from `getEffectiveContextTokens()` (llm-direct) → `config.contextTokens` (agent-bridge run start) → the loop.
- **Compact system prompt** (`src/lib/agent/prompts/navigator-prompt.ts`, `buildNavigatorPrompt(..., compact)`): used for <128k models. Every security/schema/behavior block is byte-identical to the full prompt; only prose is compressed. Chosen in `llm-direct.ts`'s navigator compile when the effective context is <128k.
- **Stealth is DEFAULT-ON** (`src/lib/agent/anti-detection-utils.ts`): `isStealthEnabled()` returns true unless storage explicitly says `false`, and `isStealthEnabledSync()` fails toward stealth. Page-visible artifacts (phantom cursor, click highlight, piercer backdoor) are suppressed in stealth mode and run only when stealth is explicitly disabled.
- **Manual pause/resume** is wired end-to-end: the sidepanel Pause button writes `open_cowork_paused` to `chrome.storage.session`; the loop's `runPauseCheck` polls it; the Resume button (or any RESUME message) clears it in `message-routing.ts`.
- **64k survival is a tested invariant** — `tests/agent-loop-64k.test.ts` drives the real loop at 20/50/100 steps with repeated compactions and per-turn input accounting; `tests/compact-prompt.test.ts` and `tests/navigator-observation-caps.test.ts` pin the budget derivation.

## Testing

- **Vitest v4** honors the `isolate: true` config option (per-file module + mock reset). `tests/helpers/test-isolation.ts` (loaded via `setupFiles`) additionally resets leaked globals (`globalThis.chrome`, `document.body`, `localStorage`, `fetch`) between test files as defense-in-depth. Don't remove it.
- Test files live in `tests/` with `.test.ts` suffix.
- Coverage thresholds are pinned at measured baselines with per-glob overrides for security-critical modules (`ssrf-ipv6.ts`, `ssrf-validate.ts`, `ssrf-dns.ts`, `security-injection.ts`, `auth.ts`, `endpoint.ts`, `anti-bot.ts`, `anti-detection.ts`). The baselines are documented in `vitest.config.ts`.

## CI

`.github/workflows/ci.yml` runs on push/PR to `main`/`master`:
1. `npm ci` → `npm run lint` → `npx tsc --noEmit` → `npx vitest run --coverage` → `npm run build:extension` → verify build output → `npm audit --audit-level=high` + `npm audit signatures`
2. `secret-scan` job runs gitleaks against full history using `.github/gitleaks.toml` (allows fake secret fixtures in 5 test files).

`.github/workflows/dependency-review.yml` blocks PRs with moderate+ vulnerability advisories or GPL-3.0/AGPL-3.0 licenses.

## LLM providers

7 dedicated wrappers in `src/lib/agent/llm/providers/`: `anthropic.ts`, `azure.ts`, `google.ts`, `openai.ts`, `openai-compatible.ts`, `openrouter.ts`, `xai.ts`. 13 more OpenAI-compatible services (15 profile-table rows; openrouter + xai also have dedicated wrappers) use a shared profile table (`openai-compatible-profile.ts`). Protocols in `src/lib/agent/llm/protocols/`.

## Gotchas

- `chrome-extension/` is gitignored — never commit build output. It's generated by `npm run build:extension`.
- The `evaluate` sandbox runs JS via `new Function()` in the page's isolated world. It's a second defense layer, not a hard wall — use Full Agentic mode only on trusted sites.
- `src/lib/agent/agent/` does NOT exist; the agent code lives directly under `src/lib/agent/` (no `agent/` subdirectory).
- The `zod-locales-stub.js` file in `src/extension/` is required for the build — the zod-locales plugin redirects imports to it.
