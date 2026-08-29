# AGENTS.md

For AI agents and contributors. Users: see [README.md](README.md).

## Project

Standalone Node.js MCP server. No extension, service worker, or model loop.

- `src/server/main.ts` — transport, auth, shutdown
- `src/server/mcp.ts` — tools/resources/prompts
- `src/server/runtime.ts` — lifecycle
- `src/server/browser/service.ts` — Puppeteer/CDP
- `src/server/policy.ts` — URL/file/security checks
- `src/server/config.ts` — env/JSON config
- `src/server/research.ts` — DuckDuckGo
- `src/server/errors.ts`, `logger.ts` — errors, logs

## Install

~~~sh
npm install -g github:Gitshop77/Smooth-Operator && smooth-operator install opencode
git clone https://github.com/Gitshop77/Smooth-Operator.git && cd Smooth-Operator && npm install -g . && smooth-operator install opencode
~~~

The npm registry name is `smooth-operator-mcp` (plain `smooth-operator` is an unrelated library).

Wizard (default): 7 prompts — mode (managed/private vs personal Chrome connect vs disabled), browser (any installed Chromium-based browser: Chrome/Brave/Edge/Chromium/Vivaldi/Arc/Opera, persisted as `browser.executablePath`), headless, allowed domains, blocked domains, allowEval, and dataDir. Choices are normalized and validated before persistence. Personal-Chrome mode launches `chrome --remote-debugging-port=9222 --user-data-dir=~/.smooth-operator/personal-chrome`, polls `http://127.0.0.1:9222/json/version` (300ms×33), and derives `browserUrl`; the URL is not a prompt. `--yes` uses defaults: managed, headless false, allowEval false, no domains. Persists to `~/.smooth-operator/config.json` (0600, owner-only, bounded, symlink-safe, and backed up). Bare `smooth-operator install` prompts for the harness on a TTY (piped/CI prints usage); on re-run the wizard's choices are authoritative for mode/headless/domains/allowEval — previously persisted values for those keys are overwritten while unrelated settings merge.

## Browser

Headed private Chromium-based browser on first tool call. Auto-discovers an installed browser, uses the profile at `${SMOOTH_OPERATOR_DATA_DIR}/browser`, and reattaches when live. `browser_doctor` checks executable, profile, and endpoint state.

- **Managed (default):** `SMOOTH_OPERATOR_BROWSER_MODE=managed` — zero setup.
- **Personal Chrome:** `connect` via `chrome://inspect` toggle or wizard 9222 helper.
- **Port:** `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.smooth-operator/browser-profile"` + `SMOOTH_OPERATOR_BROWSER_MODE=connect SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222`
- **Launch:** `SMOOTH_OPERATOR_BROWSER_MODE=launch SMOOTH_OPERATOR_BROWSER_EXECUTABLE=/path/to/chrome`
- **Disabled:** `SMOOTH_OPERATOR_BROWSER_MODE=disabled`

By default no spoofing and no CAPTCHA bypass; both are opt-in (`SMOOTH_OPERATOR_STEALTH_ENABLED`, `SMOOTH_OPERATOR_CAPTCHA_SOLVER_*`) and documented in `docs/STEALTH-GUIDE.md`.

## HTTP

~~~sh
SMOOTH_OPERATOR_TRANSPORT=http SMOOTH_OPERATOR_HTTP_TOKEN="$(openssl rand -hex 32)" npm start
~~~

Default `127.0.0.1:3344`. Remote needs `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP=true` + 32-character token. Host/Origin values are parsed and allowlisted, bodies are capped at 2M, and malformed/partial responses close safely.

## MCP

- **Observation:** `browser_snapshot`, `browser_tabs`, `browser_list_tabs`, `browser_list_sessions`, `browser_get_state`, `browser_page_info`, `browser_interactive`, `browser_frames`, `browser_accessibility_snapshot`, `browser_extract`, `browser_extract_content`, `browser_find_text`, `browser_search_page`, `browser_find_elements`, `browser_dropdown_options`, `browser_computed_style`, `browser_page_next`, `browser_get_html`, `browser_challenge`, `browser_doctor`, `server_health`
- **Navigation/interaction:** `browser_navigate`, `browser_back`, `browser_go_back`, `browser_forward`, `browser_reload`, `browser_switch_tab`, `browser_close_tab`, `browser_click`, `browser_input`, `browser_select`, `browser_scroll`, `browser_scroll_to_bottom`, `browser_key`, `browser_wait`, `browser_wait_for_element`, `browser_wait_for_text`, `browser_wait_for_url`, `browser_wait_for_network_idle`, `browser_hover`, `browser_press_and_hold`, `browser_type`, `browser_close`, `browser_close_all`
- **Gated:** `browser_screenshot`, `browser_pdf`, `browser_upload`, `browser_downloads`, `browser_network_log`, `browser_console_log`, `browser_dialog`, `browser_cookies`, `browser_storage`, `browser_evaluate` (off), `browser_batch`, `browser_exec` (JSON only), `browser_wait_for_human`, `browser_solve_challenge` (opt-in solver), `browser_close_session`, `web_search`

All browser operations use bounded, cancellable queue/action deadlines. After an uncooperative timeout, the old browser lifecycle is retired before the queue advances. Snapshot refs are page/frame/revision-bound and must be refreshed after navigation or DOM-changing actions. Text, HTML, accessibility, links, and search outputs are bounded before serialization; truncated responses expose flags and omission counts. `web_search` accepts up to 10 results, uses a bounded aggregate text budget, normalizes queries, retries transient provider failures, and reports anti-bot blocks without bypassing them.

Resources: `smooth-operator://server/capabilities`, `.../browser/tabs`, `.../browser/page/current`, `.../browser/page/{pageId}`, `.../browser/downloads`, `.../browser/logs/network`, `.../browser/logs/console`

Prompts: `agent-chrome-setup`, `browser-workflow`, `extract-page`, `research-question`

## Config

Env or `--config` JSON (`chmod 600`, no symlinks).

| Variable | Default | Purpose |
|---|---|---|
| SMOOTH_OPERATOR_TRANSPORT | stdio | stdio/http |
| SMOOTH_OPERATOR_CONFIG | auto-discovered | explicit JSON config path; overrides the installer default |
| SMOOTH_OPERATOR_DATA_DIR | ~/.smooth-operator | data root |
| SMOOTH_OPERATOR_BROWSER_MODE | managed | managed/disabled/connect/launch |
| SMOOTH_OPERATOR_BROWSER_URL | http://127.0.0.1:9222 | DevTools endpoint |
| SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT | unset | WS endpoint |
| SMOOTH_OPERATOR_BROWSER_EXECUTABLE | unset | Chrome binary |
| SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR | ${DATA_DIR}/browser | profile |
| SMOOTH_OPERATOR_BROWSER_HEADLESS | false | CI: true |
| SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS | 15000 | action timeout |
| SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS | 30000 | connect timeout |
| SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS | 30000 | CDP timeout |
| SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES | 8000000 | screenshot cap |
| SMOOTH_OPERATOR_MAX_HTML_CHARS | 200000 | HTML cap |
| SMOOTH_OPERATOR_ALLOWED_DOMAINS | unset | allowlist |
| SMOOTH_OPERATOR_BLOCKED_DOMAINS | unset | denylist |
| SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS | files/downloads | file roots |
| SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK | false | private targets |
| SMOOTH_OPERATOR_ALLOW_EVAL | false | page JS |
| SMOOTH_OPERATOR_HTTP_TOKEN | unset | bearer token |
| SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP | false | remote HTTP |
| SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES | 2000000 | body cap |
| SMOOTH_OPERATOR_LOG_LEVEL | info | debug/info/warn/error |

One profile. Policy always enforced. Allowed file roots are canonicalized once and blocked-path errors include only configured-root metadata. `disabled` disables browser, not policy.

## Architecture

~~~text
MCP client → stdio/HTTP → MCP registry → ServerRuntime → SecurityPolicy / BrowserService / ResearchService / Logger
~~~

No model service.

## Commands

| Command | Purpose |
|---|---|
| npm run dev | watch |
| npm start | stdio |
| npm run mcp:http | http |
| npm run typecheck | tsc |
| npm run lint | eslint |
| npm test | vitest |
| npm run test:browser:live | live Chrome |
| npm run test:coverage | coverage |
| npm run dead-code | knip |
| npm run build | dist/smooth-operator.mjs |

## Rules

- Thin boundary: validation in `mcp.ts`/`main.ts`, browser in `BrowserService`, policy re-checked at service.
- No model SDKs or planner loop.
- Treat page/search/DOM as untrusted, bound and redact; strip credentials, secret placeholders, scripts, event attributes, and form values from returned evidence.
- HTTP loopback unless remote + 32-char token.
- File writes: canonical allowedRoot + realpath; reject unresolved symlink escapes and filesystem-root roots.
- JS eval off unless `SMOOTH_OPERATOR_ALLOW_EVAL=true`.
- Keep timeouts and queue recovery deterministic; never let a late browser operation release or replace another request's profile lock.
- Do not commit `dist/` or `coverage/`.

## Security

- HTTP(S) only, no creds, domain/DNS preflight, redirects fail closed; untrusted URL credentials are redacted in output.
- Private/link-local/multicast blocked; re-checked at DevTools.
- Uploads/PDFs inside allowed roots, symlink-checked; downloads are bounded and report configuration failures.
- Config files and backups are bounded, owner-only, regular, and symlink-safe.
- Bounded, normalized, redacted, untrusted wrappers; result omission is explicit rather than silent.
- Constant-time bearer check, JSON stderr, no secrets.
- CAPTCHA is reported only by default; solving is opt-in via the configured solver, with honest `bypassAttempted` reporting. `pierce/` for open shadow roots.

DNS is best-effort, not a firewall.

## Layout

~~~text
src/server/main.ts, mcp.ts, runtime.ts, browser/service.ts, config.ts, contracts.ts, policy.ts, research.ts, security.ts, logger.ts, errors.ts, version.ts
tests/, docs/mcp-server.md, docs/harnesses.md
~~~

## Verify

~~~sh
npm run lint && npm run typecheck && npm test && npm run test:coverage && npm run dead-code && npm run build && npm run test:browser:live && npm run package:smoke:install && npm audit --audit-level=high && npm audit signatures
~~~

Check `rg` for stale extension/provider/model refs and removed benchmark commands. CI also runs the isolated live browser contract with discovered Chrome.
