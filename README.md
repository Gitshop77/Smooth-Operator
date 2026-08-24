# SmoothOperator

Give your AI a real Chrome. SmoothOperator is a tiny MCP server — your harness reasons, it clicks, types, and scrapes. No model keys. No hidden loop.

## Install — one command

Pick your harness. Run one line. Restart harness.

**From npm:**
~~~sh
npm install -g smooth-operator && smooth-operator install opencode
npm install -g smooth-operator && smooth-operator install claude-code
npm install -g smooth-operator && smooth-operator install copilot
npm install -g smooth-operator && smooth-operator install codex
npm install -g smooth-operator && smooth-operator install gemini
npm install -g smooth-operator && smooth-operator install vscode
npm install -g smooth-operator && smooth-operator install cursor
npm install -g smooth-operator && smooth-operator install windsurf
npm install -g smooth-operator && smooth-operator install claude-desktop
~~~

**From a clone:**
~~~sh
git clone https://github.com/Gitshop77/Smooth-Operator.git
cd Smooth-Operator
npm install -g . && smooth-operator install opencode
~~~

Wizard asks 6 questions (managed vs personal Chrome, headless, domains, JS). Run `smooth-operator install` with no harness to pick one interactively (TTY only; piped/CI runs print usage and exit). `--yes` skips every prompt, so give it a target: `smooth-operator install opencode --yes`. Personal Chrome → wizard launches Chrome on `9222` for you.

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

Details: [AGENTS.md](AGENTS.md) · [MCP guide](docs/mcp-server.md) · [harnesses](docs/harnesses.md)
