# SmoothOperator

Give your AI a real Chrome. SmoothOperator is a lightweight, production-grade MCP server for secure, reliable browser control. Your harness supplies the reasoning; SmoothOperator handles navigation, interaction, extraction, and browser lifecycle. No model keys. No hidden planner.

## Install — directly to your harness

Choose your harness, add SmoothOperator directly to it, and restart the harness.

**From npm** (`smooth-operator-mcp`):
~~~sh
npm install -g smooth-operator-mcp && smooth-operator install opencode
npm install -g smooth-operator-mcp && smooth-operator install claude-code
npm install -g smooth-operator-mcp && smooth-operator install copilot
npm install -g smooth-operator-mcp && smooth-operator install codex
npm install -g smooth-operator-mcp && smooth-operator install gemini
npm install -g smooth-operator-mcp && smooth-operator install vscode
npm install -g smooth-operator-mcp && smooth-operator install cursor
npm install -g smooth-operator-mcp && smooth-operator install windsurf
npm install -g smooth-operator-mcp && smooth-operator install claude-desktop
~~~

> Note: the plain-npm name `smooth-operator` is an unrelated library on the registry.
> Do NOT use `npm install -g smooth-operator`.

Or straight from GitHub:
~~~sh
npm install -g github:Gitshop77/Smooth-Operator && smooth-operator install opencode
~~~

The wizard asks exactly 3 focused questions: browser profile ownership, browser display, and the Chromium executable. Run `smooth-operator install` with no harness to pick one interactively (TTY only; piped/CI runs print usage and exit). `--yes` applies the recommended defaults, so give it a target: `smooth-operator install opencode --yes`. Personal Chrome mode launches a dedicated debugging profile on `9222` and derives `browserUrl` automatically. Managed mode owns one private persistent profile; connected mode launches and attaches to a dedicated debugging profile and does not claim ownership of an operator's daily browser.

Requires Node 22.23.2+ and an installed Chromium-based browser. Profile at `~/.smooth-operator/browser` — sign in once.

Verify: `smooth-operator --help` and `server_health` / `browser_doctor` appear after restart. `server_health` reports `ok` when the runtime is ready, `degraded` when browser recovery is required or its managed profile lease is not held, and `shutting_down` during teardown; an idle lazy browser is healthy.

For a local release check, run `npm run verify`; it covers lint, type safety,
tests, dead-code analysis, and the package smoke test.

## What it does

- Navigate and interact with real websites: click, type, select, scroll, hover, and key input
- Inspect pages with snapshots, accessibility trees, HTML, styles, text search, and bounded extraction
- Work across tabs, frames, popups, shadow DOM, dialogs, cookies, storage, downloads, screenshots, and PDFs
- Search the web through bounded DuckDuckGo retrieval
- Search a bounded metadata-only network journal by request ID, URL, method, status, and resource type
- Block page-scoped image, stylesheet, font, media, and script subresources; document and navigation requests are never selectable
- Inspect a selected element's safe attributes, styles, animations, and shallow children without returning scripts, event source, form values, or arbitrary data attributes
- Upload one file or up to 20 files from allowed roots; each file is capped at 50 MiB and the aggregate at 100 MiB
- Read, set, and delete URL-scoped cookies with validated SameSite settings; cookie values are omitted from reads

The MCP registry exposes 64 public tools. The surface includes bounded network
search, safe element inspection, page-scoped resource blocking, and file and
cookie controls alongside the navigation, extraction, and lifecycle tools.

Ask: *“Scrape pricing into a table”*, *“Fill this form with ~/resume.pdf”*, or *“Download the monthly report as a PDF.”*

## How to use

Talk to your harness normally. It can call `browser_navigate` → `browser_snapshot` → `browser_click` and the rest of the MCP surface as needed. For a challenge, `browser_solve_challenge` returns fresh bounded visual/state evidence and an attempt budget; the connected AI keeps using ordinary browser actions and calls it again until the final classification is clear or the budget is exhausted. Human handoff remains available only as an explicit final option.

Browser identity remains native, page JavaScript is available by default, and
behavioral timing is off for fast deterministic input. Set the explicit
environment flags to change those choices. See the [browser compatibility guide](docs/STEALTH-GUIDE.md) for
details and responsible use.

For the fastest supported operation, keep behavioral timing off with
`SMOOTH_OPERATOR_BEHAVIOR_ENABLED=false`; the native browser remains bounded and
cancellable. All local browser tools and page features are available by default;
remote HTTP, private-network access, and file roots remain explicitly gated.
Faster calls do not bypass challenges or grant permission to automate a site.

Managed mode preflights a regular executable when it needs to launch, and
launch mode does so before invoking Chromium. Both wait for browser launch
readiness and a target-guard acknowledgement before returning a usable
connection. The loopback DevTools `/json/version` probe is bounded to 64 KiB
before JSON parsing. There is no arbitrary CDP or host-code tool; page
evaluation remains an explicit page capability.

## Why

- Zero setup — managed, headed, persistent browser by default
- Secure by default — domain and file policy, bounded outputs, redaction, and explicit safety boundaries
- Reliable — private profiles, stale-reference recovery, reconnect handling, and structured errors
- Flexible — stdio by default, Streamable HTTP when you need it, plus connect and disabled modes

For HTTP deployments, the configured MCP path also has a bounded readiness
endpoint at `<path>/healthz` (normally `/mcp/healthz`), subject to the same
HTTP authentication policy as the MCP endpoint.

## Benchmarks

Compared with [Browser Use MCP](https://github.com/browser-use/browser-use) · [![Browser Use GitHub stars](https://img.shields.io/github/stars/browser-use/browser-use?style=social)](https://github.com/browser-use/browser-use) 

Tested: 26 August 2026

| Benchmark | Metric | SmoothOperator | Browser Use MCP |
| --- | --- | ---: | ---: |
| Live Web (8 sites, 32 episodes) | URL success | **32/32** | 23/32 |
| Live Web | Page-text quality | **26/32** | 21/32 |
| Live Web | Combined success | **26/32** | 18/32 |
| Live Web | Task latency mean / p95 | **1,358 / 2,957 ms** | 4,604 / 30,780 ms |
| Live Web | Navigation p95 | **2,130 ms** | 4,320 ms |
| Live Web | Click p95 | 920 ms | **142 ms** |
| Live Web | MCP call p95 | **943 ms** | 2,095 ms |
| Live Web | Trace errors | **0** | 10 |
| MiniWoB++ 0.14.3 (125 tasks) | Reward = 1 | **124/125** | 89/125 |
| MiniWoB++ | Attempts | **125** | 125 |
| MiniWoB++ | MCP errors | **0** | 29 |
| MiniWoB++ | Transport errors | **0** | **0** |
| MiniWoB++ | Timeouts | **0** | **0** |
| Browser Use benchmark | Muse Spark 1.2 · score | **64% · 100 tasks** | 12% · 60 tasks |

*Task counts and scoring rules differ; comparison is directional.*

[View the Browser Use benchmark](https://github.com/browser-use/benchmark)
