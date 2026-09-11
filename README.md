# SmoothOperator

Give your AI a real Chrome. SmoothOperator is a production MCP server for
secure browser control. Your harness supplies the reasoning; SmoothOperator
handles navigation, interaction, extraction, and browser lifecycle. No model
keys. No hidden planner.

## Install

**From npm** (`smooth-operator-mcp`):

```sh
npm install -g smooth-operator-mcp && smooth-operator install opencode
npm install -g smooth-operator-mcp && smooth-operator install claude-code
npm install -g smooth-operator-mcp && smooth-operator install copilot
npm install -g smooth-operator-mcp && smooth-operator install codex
npm install -g smooth-operator-mcp && smooth-operator install gemini
npm install -g smooth-operator-mcp && smooth-operator install vscode
npm install -g smooth-operator-mcp && smooth-operator install cursor
npm install -g smooth-operator-mcp && smooth-operator install windsurf
npm install -g smooth-operator-mcp && smooth-operator install claude-desktop
```

The plain-npm name `smooth-operator` is an unrelated library. Do **not** run
`npm install -g smooth-operator`.

From GitHub:

```sh
npm install -g github:Gitshop77/Smooth-Operator && smooth-operator install opencode
```

The wizard asks exactly three questions: browser profile ownership, browser
display, and the Chromium executable. `smooth-operator install` without a
harness chooses one on a TTY (piped/CI prints usage). `--yes` applies
recommended defaults: `smooth-operator install opencode --yes`.

Managed mode owns one private persistent profile
(`~/.smooth-operator/browser`). Wizard Personal Chrome launches a dedicated
debugging profile on port `9222` and derives `browserUrl`; it does not take
over daily Chrome. Connect mode attaches to the configured `browserURL` /
`wsEndpoint`.

Requires Node.js 22.23.2+ and an installed Chromium-based browser.

```sh
smooth-operator --help
smooth-operator doctor
```

After restart, ask the harness to run `server_health` and `browser_doctor`.
`server_health` reports `ok` when ready, `degraded` when recovery or the
profile lease is needed, and `shutting_down` during teardown. An idle lazy
browser is healthy.

Local check: `npm run verify` (lint, typecheck, coverage tests, knip, package
smoke/build). `npm test` and coverage exclude `tests/browser-live.test.ts`.
Live Chrome is only `npm run test:browser:live`.

## What it does

The MCP registry exposes **57 public tools**. Each listed name does one job.
Navigate and interact; inspect with snapshots, accessibility, HTML, styles,
and bounded extraction; work across tabs, frames, popups, shadow DOM,
dialogs, cookies, storage, downloads, screenshots, and PDFs; search the web
through bounded DuckDuckGo retrieval; search a metadata-only network journal;
block page-scoped subresources; inspect elements without scripts, event
source, or form values; upload up to 20 files from allowed roots (50 MiB
each, 100 MiB aggregate). Cookie values are omitted from reads. Operations:
cookies `get`/`set`/`delete`; storage and resource-blocking `get`/`set`/`clear`;
network and console logs `enable`/`disable`/`read`/`clear`/`read_and_clear`;
dialogs `get_text`/`accept`/`dismiss`/`send_keys`.

Preferred loop: `browser_navigate` / `browser_snapshot` → one mutation →
verify. Element actions accept exactly one of `target`, `ref`
(`e5`/`ref:e5`), CSS `selector`, or zero-based `index`. `browser_click`,
`browser_move`, and `browser_press_and_hold` also accept
`coordinateX`/`coordinateY` (hold also start/end coordinates or a path).
Set `includeSnapshot: true` to combine a mutation with its trailing snapshot.

Canonical tools: `browser_tabs`, `browser_snapshot`, `browser_input`,
`browser_back`, `browser_close`, `browser_extract`, `browser_wait`,
`browser_network_log`, `browser_challenge`, `browser_batch`. Compatibility
aliases are not listed.

`browser_solve_challenge` returns fresh bounded evidence. The connected AI
uses ordinary browser actions until a fresh classification reports the
challenge **absent** or the attempt budget is exhausted. Human handoff
(`browser_wait_for_human`) is an explicit last option. There is no captcha
solver. Identity stays native: launch args do not fabricate UA,
platform, WebGL, canvas, client hints, or `navigator.webdriver`.

HTTP deployments expose `<path>/healthz` (normally `/mcp/healthz`) with the
same Host, Origin, and bearer policy as `/mcp`.

## Docs

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Tools](docs/tools.md)
- [Config](docs/config.md)
- [Harnesses](docs/harnesses.md)
- [Browser compatibility](docs/STEALTH-GUIDE.md)
- [MCP server operations](docs/mcp-server.md)
