# AGENTS.md

For AI agents and contributors. Users: see [README.md](README.md).

## Project

Standalone Node.js MCP server. No extra browser add-on, background worker, or model loop.
Package: `smooth-operator-mcp`. Bin: `smooth-operator`.

- `src/server/main.ts` — CLI: server, install, doctor
- `src/server/cli.ts` — help, version, doctor output
- `src/server/http.ts` — Streamable HTTP, healthz, graceful shutdown
- `src/server/catalog.ts` — locked 57-tool catalog, retired-name map, resources, prompts
- `src/server/mcp.ts` — registry/dispatch
- `src/server/envelope.ts` — one result envelope
- `src/server/runtime.ts` — lifecycle and exclusive profile lease
- `src/server/browser/service.ts` — Puppeteer/CDP facade
- `src/server/browser/queue.ts` — exclusive/read operation lane
- `src/server/policy.ts` — URL/file/eval checks (edge + service)
- `src/server/config.ts` — env/JSON config
- `src/server/research.ts` — DuckDuckGo
- `src/server/errors.ts`, `logger.ts` — errors, JSON stderr

## Install

```sh
npm install -g github:Gitshop77/Smooth-Operator && smooth-operator install opencode
git clone https://github.com/Gitshop77/Smooth-Operator.git && cd Smooth-Operator && npm install -g . && smooth-operator install opencode
```

The npm registry name is `smooth-operator-mcp` (plain `smooth-operator` is an unrelated library).

Wizard: exactly three prompts — browser profile ownership, browser display, and the Chromium executable. `--yes` uses managed, headed, page eval on, native-identity compatibility, and deterministic input. Personal-Chrome mode launches `chrome --remote-debugging-port=9222 --user-data-dir=~/.smooth-operator/personal-chrome`, probes `http://127.0.0.1:9222/json/version` (64 KiB max, 33 attempts / 10s), and derives `browserUrl`. Config writes use owner-only temp files, flush, atomic replace, and backup. Bare `smooth-operator install` prompts for the harness on a TTY.

CLI: `smooth-operator [server]`, `smooth-operator install [harness] --yes`, `smooth-operator doctor`.

## Browser

Private Chromium-based browser (headed by default) on first tool call. Profile at `${SMOOTH_OPERATOR_DATA_DIR}/browser`. `browser_doctor` and `smooth-operator doctor` check executable, profile, and endpoint state.

- **Managed (default):** `SMOOTH_OPERATOR_BROWSER_MODE=managed`
- **Connect:** attach to the configured DevTools endpoint (wizard uses a dedicated profile)
- **Launch:** `SMOOTH_OPERATOR_BROWSER_EXECUTABLE=...`
- **Disabled:** `SMOOTH_OPERATOR_BROWSER_MODE=disabled`

Page eval defaults on. Identity stays native (no UA/webdriver spoof). Behavioral timing defaults off. Challenges are evidence-first; see [docs/STEALTH-GUIDE.md](docs/STEALTH-GUIDE.md).

## HTTP

```sh
SMOOTH_OPERATOR_TRANSPORT=http SMOOTH_OPERATOR_HTTP_TOKEN="$(openssl rand -hex 32)" npm start
```

Default `127.0.0.1:3344`. Remote needs `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP=true` and a 32-character token. `<path>/healthz` uses the same Host, Origin, and bearer policy.

## MCP

57 public tools. One catalog. One envelope. Each listed tool does one job. Snapshot refs are page/frame/revision-bound. Truncation is explicit. `web_search` is bounded and does not bypass anti-bot. Identity is native (no fabricated UA/webdriver).

Resources: `smooth-operator://server/capabilities`, `.../browser/tabs`, `.../browser/page/current`, `.../browser/page/{pageId}`, `.../browser/downloads`, `.../browser/logs/network`, `.../browser/logs/console`.

Prompts: `agent-chrome-setup`, `browser-workflow`, `extract-page`, `research-question`.

## Config

See [docs/config.md](docs/config.md). One profile. Policy always enforced. `disabled` disables the browser, not policy.

## Architecture

```text
MCP client → stdio/HTTP → catalog/registry → ServerRuntime → SecurityPolicy / BrowserService / ResearchService / Logger
```

No model service. Details: [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/tools.md](docs/tools.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | watch |
| `npm start` | stdio |
| `npm run mcp:http` | http |
| `npm run typecheck` | tsc |
| `npm run lint` | eslint |
| `npm run verify` | lint, typecheck, coverage tests, knip, package smoke/build |
| `npm test` | vitest |
| `npm run test:browser:live` | live Chrome only; excluded from `npm test` / `test:coverage` / verify |
| `npm run test:coverage` | coverage |
| `npm run dead-code` | knip |
| `npm run build` | `dist/smooth-operator.mjs` |

## Rules

- Thin boundary: validation in `mcp.ts`/`main.ts`, browser in `BrowserService`, policy re-checked at service. The same `SecurityPolicy` methods run at the edge and again at the service.
- No model SDKs or planner loop.
- Treat page/search/DOM as untrusted; bound and redact; strip credentials, secret placeholders, scripts, event attributes, and form values.
- HTTP loopback unless remote + 32-char token.
- File writes: canonical allowedRoot + realpath; reject unresolved symlink escapes and filesystem-root roots.
- Timeouts and queue recovery are deterministic; a late browser operation must not release or replace another request's profile lock.
- Do not commit `dist/` or `coverage/`.

## Verify

```sh
npm run verify
```

Live Chrome: `npm run test:browser:live`. Packaged first-party surface must not contain extension/model-loop leftovers (`scripts/verify-package.mjs`).
