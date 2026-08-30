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

Wizard (default): exactly 3 prompts — browser profile ownership, browser display, and the Chromium executable. Choices are normalized and validated before persistence. Personal-Chrome mode launches `chrome --remote-debugging-port=9222 --user-data-dir=~/.smooth-operator/personal-chrome`, probes `http://127.0.0.1:9222/json/version` immediately and then every 300ms with bounded response reads (64 KiB maximum; 33 attempts within a default 10-second deadline), and derives `browserUrl`; the URL is not a prompt. `--yes` uses defaults: managed, headed, page eval on, native-identity compatibility, and deterministic input. Persists to `~/.smooth-operator/config.json` (0600, owner-only, bounded, symlink-safe, and backed up). Bare `smooth-operator install` prompts for the harness on a TTY (piped/CI prints usage); managed mode owns one private persistent profile, while connected mode launches and attaches to a dedicated debugging profile rather than an operator's daily browser.

## Browser

Private Chromium-based browser (headed by default) on first tool call. Auto-discovers an installed browser, uses the profile at `${SMOOTH_OPERATOR_DATA_DIR}/browser`, and reattaches when live. `browser_doctor` checks executable, profile, and endpoint state.

- **Managed (default):** `SMOOTH_OPERATOR_BROWSER_MODE=managed` — zero setup.
- **Personal Chrome:** `connect` via `chrome://inspect` toggle or wizard 9222 helper.
- **Port:** `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.smooth-operator/browser-profile"` + `SMOOTH_OPERATOR_BROWSER_MODE=connect SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222`
- **Launch:** `SMOOTH_OPERATOR_BROWSER_MODE=launch SMOOTH_OPERATOR_BROWSER_EXECUTABLE=/path/to/chrome`
- **Disabled:** `SMOOTH_OPERATOR_BROWSER_MODE=disabled`

All local browser tools and features are available by default, including page
eval and the identity-preserving compatibility profile. Behavioral timing is
off for the fastest deterministic path. Set
`SMOOTH_OPERATOR_ALLOW_EVAL=false` or `SMOOTH_OPERATOR_STEALTH_ENABLED=false`
to disable those features. Set `SMOOTH_OPERATOR_BEHAVIOR_ENABLED=true` only
when timing wrappers are needed;
challenge handling remains evidence-first and is documented in
`docs/STEALTH-GUIDE.md`.

## HTTP

~~~sh
SMOOTH_OPERATOR_TRANSPORT=http SMOOTH_OPERATOR_HTTP_TOKEN="$(openssl rand -hex 32)" npm start
~~~

Default `127.0.0.1:3344`. Remote needs `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP=true` + 32-character token. Host/Origin values are parsed and allowlisted, bodies are capped at 2M, and malformed/partial responses close safely.

## MCP

- **64 public tools. Observation:** `browser_snapshot`, `browser_tabs`, `browser_list_tabs`, `browser_list_sessions`, `browser_get_state`, `browser_page_info`, `browser_interactive`, `browser_frames`, `browser_accessibility_snapshot`, `browser_extract`, `browser_extract_content`, `browser_find_text`, `browser_search_page`, `browser_find_elements`, `browser_inspect_element`, `browser_dropdown_options`, `browser_computed_style`, `browser_page_next`, `browser_get_html`, `browser_search_network_log`, `browser_challenge`, `browser_doctor`, `server_health`
- **Navigation/interaction:** `browser_navigate`, `browser_back`, `browser_go_back`, `browser_forward`, `browser_reload`, `browser_switch_tab`, `browser_close_tab`, `browser_click`, `browser_input`, `browser_select`, `browser_scroll`, `browser_scroll_to_bottom`, `browser_key`, `browser_wait`, `browser_wait_for_element`, `browser_wait_for_text`, `browser_wait_for_url`, `browser_wait_for_network_idle`, `browser_hover`, `browser_move`, `browser_press_and_hold`, `browser_type`, `browser_close`, `browser_close_all`
- **Local defaults:** all browser tools/features are available by default, including `browser_evaluate`, `browser_resource_blocking`, and safe element inspection; `browser_exec` accepts validated JSON actions only, and `browser_wait_for_human` remains an optional handoff. Remote HTTP, private-network access, and file roots retain explicit policy gates.

All browser operations use bounded, cancellable queue/action deadlines. After an uncooperative timeout, the old browser lifecycle is retired before the queue advances. Snapshot refs are page/frame/revision-bound and must be refreshed after navigation or DOM-changing actions. Text, HTML, accessibility, links, and search outputs are bounded before serialization; truncated responses expose flags and omission counts. `web_search` accepts up to 10 results, uses a bounded aggregate text budget, normalizes queries, retries transient retrieval failures, and reports anti-bot blocks without bypassing them. Network journal search is bounded, metadata-only, and redacts secret query values.

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
| SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH / _HEIGHT | unset | Set both for an explicit viewport |
| SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH | false | Legacy connect-mode recovery option |
| SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS | 15000 | action timeout |
| SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS | 30000 | connect timeout |
| SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS | 30000 | CDP timeout |
| SMOOTH_OPERATOR_BROWSER_IDLE_TIMEOUT_MS | 0 | idle cleanup; 0 disabled, maximum 24 hours |
| SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES | 8000000 | screenshot cap |
| SMOOTH_OPERATOR_MAX_HTML_CHARS | 200000 | HTML cap |
| SMOOTH_OPERATOR_ALLOWED_DOMAINS | unset | allowlist |
| SMOOTH_OPERATOR_BLOCKED_DOMAINS | unset | denylist |
| SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS | files/downloads | file roots |
| SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK | false | private targets |
| SMOOTH_OPERATOR_ALLOW_EVAL | true | Set false to disable page JS |
| SMOOTH_OPERATOR_STEALTH_ENABLED | true | compatibility script; identity/signals remain native |
| SMOOTH_OPERATOR_STEALTH_PROFILE | balanced | accepted profile name |
| SMOOTH_OPERATOR_STEALTH_GPU | false | opt-in GPU flags |
| SMOOTH_OPERATOR_BEHAVIOR_ENABLED | false | opt-in timing wrappers |
| SMOOTH_OPERATOR_HTTP_HOST | 127.0.0.1 | HTTP bind host |
| SMOOTH_OPERATOR_HTTP_PORT | 3344 | HTTP bind port |
| SMOOTH_OPERATOR_HTTP_PATH | /mcp | HTTP endpoint path |
| SMOOTH_OPERATOR_HTTP_TOKEN | unset | bearer token |
| SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP | false | remote HTTP |
| SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES | 2000000 | body cap |
| SMOOTH_OPERATOR_ALLOWED_HOSTS / _ORIGINS | localhost, loopback | HTTP allowlists |
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
| npm run benchmark:network | deterministic bounded network-journal benchmark |
| npm run build | dist/smooth-operator.mjs |

## Rules

- Thin boundary: validation in `mcp.ts`/`main.ts`, browser in `BrowserService`, policy re-checked at service.
- No model SDKs or planner loop.
- Treat page/search/DOM as untrusted, bound and redact; strip credentials, secret placeholders, scripts, event attributes, and form values from returned evidence.
- HTTP loopback unless remote + 32-char token.
- File writes: canonical allowedRoot + realpath; reject unresolved symlink escapes and filesystem-root roots.
- JS eval defaults on for the native capability profile; set `SMOOTH_OPERATOR_ALLOW_EVAL=false` to disable it.
- Keep timeouts and queue recovery deterministic; never let a late browser operation release or replace another request's profile lock.
- Do not commit `dist/` or `coverage/`.

## Security

- HTTP(S) only, no creds, domain/DNS preflight, redirects fail closed; untrusted URL credentials are redacted in output.
- Private/link-local/multicast blocked; re-checked at DevTools.
- Uploads/PDFs inside allowed directory roots, symlink-checked; existing regular files are not roots; uploads allow 20 files maximum, 50 MiB per file, and 100 MiB aggregate, and clean every staging path on all outcomes. More than one upload requires an input with `multiple`; downloads are bounded and report configuration failures.
- Resource blocking is page-scoped to image, stylesheet, font, media, and script subresources; document/navigation cannot be selected, matching requests abort once without navigation errors, and non-blocked requests still run full URL policy.
- Managed and launch connections require a regular executable, a bounded 64 KiB `/json/version` probe before JSON parsing, and target auto-attach readiness acknowledgement.
- There is no generic arbitrary CDP or host-code execution surface; page evaluation is the explicit page-JavaScript capability.
- Config files and backups are bounded, owner-only, regular, and symlink-safe.
- Bounded, normalized, redacted, untrusted wrappers; result omission is explicit rather than silent.
- Constant-time bearer check, JSON stderr, no secrets.
- Challenges are classified from bounded evidence. `browser_solve_challenge` is
  an internal connected-AI observe/act/verify loop, and it reports success only
  when a fresh final classification is explicitly absent. `pierce/` is used
  only for open shadow roots.

DNS is best-effort, not a firewall.

## Layout

~~~text
src/server/main.ts, mcp.ts, runtime.ts, browser/service.ts, config.ts, contracts.ts, policy.ts, research.ts, security.ts, logger.ts, errors.ts, version.ts
tests/, docs/mcp-server.md, docs/harnesses.md, docs/STEALTH-GUIDE.md
~~~

## Verify

~~~sh
npm run lint && npm run typecheck && npm test && npm run test:coverage && npm run dead-code && npm run build && npm run test:browser:live && npm run package:smoke:install && npm audit --audit-level=high && npm audit signatures
~~~

Check `rg` for unsupported extension/model references in packaged surfaces. CI also runs the isolated live browser contract with discovered Chrome.
