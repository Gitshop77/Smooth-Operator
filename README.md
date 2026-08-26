# SmoothOperator

Give your AI a real Chrome. SmoothOperator is a tiny MCP server — your harness reasons, it clicks, types, and scrapes. No model keys. No hidden loop.

## Install — one command

Pick your harness. Run one line. Restart harness.

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

Wizard asks 7 questions (browser mode, executable, headless, allowed/blocked domains, JavaScript, and data directory). Run `smooth-operator install` with no harness to pick one interactively (TTY only; piped/CI runs print usage and exit). `--yes` skips every prompt, so give it a target: `smooth-operator install opencode --yes`. Personal Chrome → wizard launches Chrome on `9222` and derives `browserUrl` for you.

Requires Node 22.23.2+ and Chrome. Profile at `~/.smooth-operator/browser` — sign in once.

Verify: `smooth-operator --help` and `server_health` / `browser_doctor` appear after restart.

## What it does

- Click, type, select, scroll, hover
- Extract, find text, snapshot, screenshot, PDF, upload
- Handle tabs, dialogs, cookies, storage
- Search web (DuckDuckGo)

Ask: *“Scrape pricing into a table”* / *“Fill this form with ~/resume.pdf”* / *“Download monthly report as PDF”*

## How to use

Talk to your harness normally. It will call `browser_navigate` → `browser_snapshot` → `browser_click` etc. Logins/CAPTCHAs pause for you in the Chrome window.

## Why

- Zero config — headed, private, persistent Chrome
- Private — `~/.smooth-operator`, 0600 permissions
- Safe — domain policy, bounded outputs, JS off by default (`SMOOTH_OPERATOR_ALLOW_EVAL`)
- Works — stdio default, HTTP optional

## Benchmarks

| Benchmark | Metric | SmoothOperator | Browser Use MCP |
| --- | --- | ---: | ---: |
| Live Web (8 sites, 32 episodes) | URL success | **32/32** | 23/32 |
| Live Web | Page-text quality | **26/32** | 21/32 |
| Live Web | Combined success | **26/32** | 18/32 |
| Live Web | Task latency mean / p95 | **1,357.697 / 2,957.241 ms** | 4,603.811 / 30,780.107 ms |
| Live Web | Navigation p95 | **2,130.255 ms** | 4,320.076 ms |
| Live Web | Click p95 | 919.812 ms | **142.231 ms** |
| Live Web | MCP call p95 | **942.979 ms** | 2,095.407 ms |
| Live Web | Trace errors | **0** | 10 |
| MiniWoB++ 0.14.3 (125 tasks) | Reward = 1 | **124/125** | 89/125 |
| MiniWoB++ | Attempts | **125** | 125 |
| MiniWoB++ | MCP errors | **0** | 29 |
| MiniWoB++ | Transport errors | **0** | **0** |
| MiniWoB++ | Timeouts | **0** | **0** |
