# Smooth-Operator public inventory

The agent-facing `tools/list` is 57 one-job tools, 6 resources, 1 resource
template, and 4 prompts. Compatibility aliases are not listed. See
[docs/tools.md](tools.md) for unlisted aliases and retired `browser_logs`.

Verify/coverage floors (`vitest.config.ts`; not a live-Chrome run):

| Metric | Threshold |
|---|---|
| Statements | 70.7 |
| Branches | 64.7 |
| Functions | 77.2 |
| Lines | 72.7 |

`npm run verify` / `npm test` / `npm run test:coverage` exclude
`tests/browser-live.test.ts`. Live Chrome is only
`npm run test:browser:live`.

Contract snapshot fingerprint: see `tests/contract-snapshot.test.ts`.

Package: `smooth-operator-mcp` @ 3.2.0. Bin: `smooth-operator`. Engines: Node `>=22.23.2`, npm `>=12.0.2`.

## Product law

This process is a browser MCP server. The harness reasons.

- No model SDK, planner loop, packaged browser add-on, or arbitrary CDP/host-code tool.
- Fail closed. Bound and redact untrusted page data. One profile lease.
- Keep every published capability reachable through a canonical tool plus arguments.

## Public tools (57, registration order)

Compatibility aliases are not listed. Each name does one job. Cookies
`get`/`set`/`delete`; storage and resource-blocking `get`/`set`/`clear`;
network/console logs `enable`/`disable`/`read`/`clear`/`read_and_clear`;
dialogs `get_text`/`accept`/`dismiss`/`send_keys`.

| # | Name | Annotations |
|---|---|---|
| 1 | `browser_snapshot` | browser read-only |
| 2 | `browser_tabs` | browser read-only |
| 3 | `browser_list_sessions` | closed-world read-only |
| 4 | `browser_close_session` | closed-world destructive |
| 5 | `browser_get_html` | browser read-only |
| 6 | `browser_navigate` | browser mutating |
| 7 | `browser_click` | browser mutating |
| 8 | `browser_input` | browser mutating |
| 9 | `browser_select` | browser mutating |
| 10 | `browser_scroll` | browser mutating |
| 11 | `browser_scroll_to_bottom` | browser mutating |
| 12 | `browser_key` | browser mutating |
| 13 | `browser_switch_tab` | browser mutating |
| 14 | `browser_close_tab` | browser destructive |
| 15 | `browser_back` | browser mutating |
| 16 | `browser_forward` | browser mutating |
| 17 | `browser_reload` | browser mutating |
| 18 | `browser_close` | browser destructive |
| 19 | `browser_wait` | browser read-only |
| 20 | `browser_wait_for_element` | browser read-only |
| 21 | `browser_wait_for_text` | browser read-only |
| 22 | `browser_wait_for_url` | browser read-only |
| 23 | `browser_wait_for_network_idle` | browser read-only |
| 24 | `browser_network_log` | browser destructive |
| 25 | `browser_search_network_log` | browser read-only |
| 26 | `browser_resource_blocking` | browser mutating |
| 27 | `browser_console_log` | browser destructive |
| 28 | `browser_find_text` | browser mutating |
| 29 | `browser_extract` | browser read-only |
| 30 | `browser_upload` | browser mutating |
| 31 | `browser_screenshot` | browser read-only |
| 32 | `browser_pdf` | browser destructive |
| 33 | `browser_downloads` | browser read-only |
| 34 | `browser_dropdown_options` | browser read-only |
| 35 | `browser_page_next` | browser read-only |
| 36 | `browser_search_page` | browser read-only |
| 37 | `browser_find_elements` | browser read-only |
| 38 | `browser_inspect_element` | browser read-only |
| 39 | `browser_interactive` | browser read-only |
| 40 | `browser_frames` | browser read-only |
| 41 | `browser_accessibility_snapshot` | browser read-only |
| 42 | `browser_computed_style` | browser read-only |
| 43 | `browser_page_info` | browser read-only |
| 44 | `browser_hover` | browser mutating |
| 45 | `browser_move` | browser mutating |
| 46 | `browser_press_and_hold` | browser mutating |
| 47 | `browser_challenge` | browser read-only |
| 48 | `browser_wait_for_human` | browser read-only |
| 49 | `browser_solve_challenge` | browser mutating |
| 50 | `browser_evaluate` | browser destructive |
| 51 | `browser_batch` | browser destructive |
| 52 | `browser_dialog` | browser destructive |
| 53 | `browser_cookies` | browser destructive |
| 54 | `browser_storage` | browser destructive |
| 55 | `web_search` | browser read-only |
| 56 | `server_health` | closed-world read-only |
| 57 | `browser_doctor` | closed-world read-only |

Closed-world tools: `server_health`, `browser_doctor`, `browser_list_sessions`, `browser_close_session`.

## Resources

| Name | URI |
|---|---|
| `server-capabilities` | `smooth-operator://server/capabilities` |
| `browser-tabs` | `smooth-operator://browser/tabs` |
| `browser-current-snapshot` | `smooth-operator://browser/page/current` |
| `browser-downloads` | `smooth-operator://browser/downloads` |
| `browser-network-log` | `smooth-operator://browser/logs/network` |
| `browser-console-log` | `smooth-operator://browser/logs/console` |
| `browser-page` (template) | `smooth-operator://browser/page/{pageId}` |

## Prompts

| Name | Args |
|---|---|
| `agent-chrome-setup` | none |
| `browser-workflow` | `task` required, `url` optional |
| `extract-page` | `question` required |
| `research-question` | `question` required |

## Environment variables

See `AGENTS.md` and `.env.example`. Core: `SMOOTH_OPERATOR_TRANSPORT`, `SMOOTH_OPERATOR_CONFIG`, `SMOOTH_OPERATOR_DATA_DIR`, `SMOOTH_OPERATOR_BROWSER_MODE` (`managed`/`connect`/`launch`/`disabled`), executable/URL/WS/user-data/headless/viewport/timeouts, domain and file policy, eval/stealth/behavior, HTTP bind/token/allowlists, log level.

Removed (fail closed): `SMOOTH_OPERATOR_BROWSER_PROFILE`, `SMOOTH_OPERATOR_BROWSER_STEALTH`, `SMOOTH_OPERATOR_DEFAULT_MODE`, `SMOOTH_OPERATOR_BROWSER_USER_AGENT`.

## Error classes

`AppError` with deterministic `code`, `retryable`, `status`, optional `details`. Client payload omits `cause`. Recovery hints for `STALE_REFERENCE`/`STALE_SNAPSHOT`, `STALE_PAGE_SLICE`, `FRAME_NOT_FOUND`/`FRAME_MISMATCH`, `ELEMENT_NOT_FOUND`/`ELEMENT_NOT_VISIBLE`, `DIALOG_PENDING`, `BROWSER_RECOVERY_REQUIRED`.

Representative codes: `CONFIG_INVALID`, `CONFIG_INSECURE`, `URL_BLOCKED`, `URL_INVALID`, `DOMAIN_BLOCKED`, `DOMAIN_NOT_ALLOWED`, `PRIVATE_NETWORK_BLOCKED`, `DNS_RESOLUTION_FAILED`, `FILE_PATH_BLOCKED`, `EVALUATE_DISABLED`, `BROWSER_DISABLED`, `BROWSER_PROFILE_IN_USE`, `BROWSER_RECOVERY_REQUIRED`, `SEARCH_BLOCKED`, `CANCELLED`, `SERVER_CLOSING`.

## Security gates

1. HTTP(S) only; credentials in URLs rejected; redirects re-checked and fail closed.
2. Domain allow/deny compiled once; private/link-local/multicast blocked unless opted in; loopback allowed.
3. DNS preflight (deny-only cache); browser resolver is not pinned.
4. File roots canonicalized once; symlink escapes fail closed; roots cannot be filesystem root or a regular file.
5. Page eval gated by `allowEval` (default on); no arbitrary CDP/host-code tool.
6. Uploads: 20 files, 50 MiB each, 100 MiB aggregate, staging cleaned on all outcomes.
7. Resource blocking: page-scoped image/stylesheet/font/media/script only.
8. Outputs bound and redacted: scripts, event attributes, form values, cookie values, secrets, credential URLs.
9. HTTP: loopback unless remote + 32-char token; Host/Origin allowlists; constant-time bearer; `healthz` shares the same policy.
10. One exclusive profile lease; a timed-out operation cannot release another request's lock.
11. Challenges classified from bounded title/text/HTML/frame/marker evidence. Success requires a fresh **absent** classification.
12. Research is bounded DuckDuckGo HTML; anti-bot is reported, never bypassed (`redirect: "error"`).

## CLI

`smooth-operator [server]`, `smooth-operator install [harness] --yes`,
`smooth-operator doctor`. `browser_doctor` remains the MCP tool. Wizard
remains three questions: profile ownership, display, Chromium executable.

Harnesses: `claude-code`, `opencode`, `copilot`, `codex`, `gemini`, `vscode`, `cursor`, `windsurf`, `claude-desktop`.

## Result envelope

Success: `content[0].text === JSON.stringify(structuredContent)` (non-objects wrapped as `{ value }`). Errors: `{ ok: false, error: { code, message, retryable, details?, recovery? } }` with the same text/structured equality. Truncation is explicit (`truncated`, `mcpOutputTruncated`, `*Truncated`, omission counts). Silent truncation is forbidden.

## Browser modes

| Mode | Ownership | Attach |
|---|---|---|
| `managed` | Private profile under data dir | Reattach via DevToolsActivePort or launch |
| `connect` | Configured endpoint | Attach to `browserURL` / `wsEndpoint`. Wizard Personal Chrome uses `~/.smooth-operator/personal-chrome`. Advanced `chrome://inspect` daily-profile attach is opt-in (`mcp-server.md`). |
| `launch` | Configured executable + profile | Launch then attach |
| `disabled` | None | Browser tools fail `BROWSER_DISABLED`; policy still enforced |
