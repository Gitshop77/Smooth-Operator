# SmoothOperator MCP server

This document is the operational reference for the standalone Node.js server.
It assumes that an MCP client is already installed and can launch a local
stdio process or connect to a Streamable HTTP endpoint.

## What the server owns

SmoothOperator is a protocol server, not an autonomous application. The client
decides when to call a tool and how to reason about its result. The server
validates each request, applies the same policy again at the browser and file
boundaries, performs the requested operation, and returns bounded MCP content.
It has no model credentials, model selection, or hidden planning cycle.

At runtime the composition is:

```text
MCP client
  ├─ stdio transport, or Streamable HTTP transport
  └─ MCP registry (tools, resources, prompts)
       └─ ServerRuntime
            ├─ SecurityPolicy (URL, DNS, file, and capability checks)
            ├─ BrowserService (Puppeteer over Chrome DevTools Protocol)
            ├─ ResearchService (bounded DuckDuckGo retrieval)
            └─ Logger and safe error boundary
```

`src/server/main.ts` owns transport startup, authentication, signal handling,
and graceful shutdown. `src/server/mcp.ts` registers the public protocol
surface. `src/server/runtime.ts` owns dependency lifecycle. Browser operations
are in `src/server/browser/service.ts`; policy and configuration are in
`src/server/policy.ts` and `src/server/config.ts`.

## Install and start

Use Node.js 22.23.2 and npm 12.0.2 for the reproducible project baseline. A
published package includes the built executable:

```sh
npm install -g smooth-operator-mcp
smooth-operator --help
```

(The registry package is `smooth-operator-mcp`; plain `smooth-operator` is an unrelated library. You can also install straight from GitHub: `npm install -g github:Gitshop77/Smooth-Operator`.)

The interactive installer asks exactly three questions: (1) browser profile
ownership, (2) headed or headless display, and (3) which Chromium executable to
use. Its recommended defaults are a managed private persistent profile, headed
display, and the first detected Chromium executable. It also enables page eval,
balanced stealth, and short behavioral timing in the native profile; pass the
corresponding environment flags as `false` when those capabilities are not
wanted. Managed mode owns its profile. Connected mode launches and attaches to
a dedicated debugging profile and does not claim ownership of an operator's
daily browser.

From a checkout:

```sh
npm ci
npm run build
node dist/smooth-operator.mjs --help
```

The default transport is stdio. `npm start` runs the TypeScript source through
`tsx`; a published install runs `dist/smooth-operator.mjs` through its npm bin.
The process writes protocol messages to stdout and structured diagnostics to
stderr. Do not redirect ordinary logs into stdout while using stdio.

## Stdio transport

Stdio is the preferred local integration because no listening socket is
created. An MCP client launches the executable and speaks JSON-RPC over its
stdin/stdout pipes. A generic server entry looks like this:

```json
{
  "mcpServers": {
    "SmoothOperator": {
      "command": "smooth-operator",
      "args": []
    }
  }
}
```

If the client starts with a restricted `PATH`, use an absolute Node executable
and absolute bundled entrypoint instead:

```json
{
  "mcpServers": {
    "SmoothOperator": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/smooth-operator.mjs"]
    }
  }
}
```

The built-in installer uses this absolute form for GUI configuration files
when it is running from the published bundle. Command-line harnesses retain
their native CLI command and the portable `smooth-operator` name. See
[harnesses.md](harnesses.md) for each client.

Useful command-line forms:

```sh
smooth-operator --version
smooth-operator --help
smooth-operator --transport stdio
smooth-operator --transport stdio --config /absolute/path/config.json
```

`--config`, `--transport`, `--host`, and `--port` accept one value each. An
unknown option or duplicate option fails closed before the runtime starts.

## Streamable HTTP transport

HTTP is opt-in and uses the MCP Streamable HTTP adapter. Keep it on loopback
for local clients:

```sh
SMOOTH_OPERATOR_TRANSPORT=http \
SMOOTH_OPERATOR_HTTP_HOST=127.0.0.1 \
SMOOTH_OPERATOR_HTTP_PORT=3344 \
SMOOTH_OPERATOR_HTTP_TOKEN="$(openssl rand -hex 32)" \
smooth-operator
```

The endpoint is `/mcp` by default. Every request must pass the configured Host
and Origin validation and include `Authorization: Bearer <token>`. The token
is compared in constant time. Request bodies are bounded to 2,000,000 bytes by
default and concurrent requests are capped. The process drains in-flight work
for a short bounded period on SIGINT/SIGTERM, then closes the MCP handler,
browser, and HTTP server.

Remote binding is deliberately guarded:

```sh
SMOOTH_OPERATOR_TRANSPORT=http \
SMOOTH_OPERATOR_HTTP_HOST=0.0.0.0 \
SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP=true \
SMOOTH_OPERATOR_HTTP_TOKEN="$(openssl rand -hex 32)" \
SMOOTH_OPERATOR_ALLOWED_HOSTS=example.internal \
SMOOTH_OPERATOR_ALLOWED_ORIGINS=example.internal \
smooth-operator
```

Remote mode is rejected unless the token is at least 32 characters. Do not
use a token from a shell history, checked-in file, or shared log. A reverse
proxy can add TLS and network access controls, but it does not replace the
application token, Host/Origin allowlists, or request-size limit. Allowed host
and origin values are hostnames without a scheme; browser preflight requests
are answered only after the same Host and Origin checks.

## Browser lifecycle

The server manages one headed, persistent private Chromium-based browser session
by default. On the first browser tool call it discovers an installed browser,
launches it with `${SMOOTH_OPERATOR_DATA_DIR}/browser` as a non-default profile,
and records its loopback DevTools endpoint for later reattachment. Sign in once
in the visible window; its sessions persist in that private profile. The
`browser_doctor` tool reports executable resolution and endpoint state without
evaluating page content.

The managed browser is headed by default for sign-in and human handoff. On CI or a
displayless host, explicitly set `SMOOTH_OPERATOR_BROWSER_HEADLESS=true` or use
Xvfb. If you set both `SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH` and
`SMOOTH_OPERATOR_BROWSER_VIEWPORT_HEIGHT`, that explicit viewport is applied to
the browser and any opt-in stealth page metrics. All local browser tools and
features are available by default, including page evaluation and the balanced
stealth/short-behavior profile. Set their environment flags to `false` for a
stricter or faster profile. See `STEALTH-GUIDE.md` for challenge handling and
the remaining boundaries.

### Managed mode (default)

`SMOOTH_OPERATOR_BROWSER_MODE=managed` needs no browser setup in ordinary installs.
It checks its private `DevToolsActivePort` file, reattaches only after a bounded
loopback probe succeeds, and otherwise discovers Chrome then launches it. Set
`SMOOTH_OPERATOR_BROWSER_EXECUTABLE` only to override discovery. A second
SmoothOperator process using the same private profile is rejected by the profile lease.

`SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH` is retained for backward compatibility but is
ignored in managed mode.

Browser actions share a bounded operation queue and deadline. Independent
read-only observations may run concurrently; navigation, mutation, snapshot,
and session-control operations remain exclusive. Browser startup uses one
in-flight connection promise, so concurrent callers wait for the same
reattach/launch attempt instead of starting duplicate processes. Newly
auto-attached top-level targets are held at the CDP boundary until the
navigation policy guard is installed; targets whose attachment ownership
cannot be determined are blocked or closed. These controls reduce races but do
not make a host browser or network firewall trustworthy by themselves.

Managed and launch modes create owner-only data, files, downloads, and browser
profile directories below `SMOOTH_OPERATOR_DATA_DIR` (unless an explicit profile
path is supplied), reject unsafe symlink components, and hold a profile lease
for the runtime lifetime. A second owner receives `BROWSER_PROFILE_IN_USE`; an
incomplete shutdown retains the lock for explicit operator recovery.

### Connect mode

Connect mode remains available for advanced, externally managed browser setups.
Chrome 144+ also offers an opt-in route through the remote-debugging toggle at
`chrome://inspect`; attach with connect mode and its reported endpoint only when
you intentionally want to control that daily profile.

For the classic route, start a dedicated browser profile with remote debugging
enabled, then point the server at the endpoint:

```sh
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.smooth-operator/browser-profile"
SMOOTH_OPERATOR_BROWSER_MODE=connect \
SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222 \
smooth-operator
```

`SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT` can be used instead when a WebSocket endpoint
is already available. A connection mode server does not own or close an
externally managed browser process.

### Launch mode

Launch mode gives the server ownership of a private browser process. Supply an
explicit executable and use an isolated profile:

```sh
SMOOTH_OPERATOR_BROWSER_MODE=launch \
SMOOTH_OPERATOR_BROWSER_EXECUTABLE=/path/to/chrome-for-testing/chrome \
SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR="$HOME/.smooth-operator/browser-profile" \
smooth-operator
```

The default profile is `${SMOOTH_OPERATOR_DATA_DIR}/browser`. Do not point it at a
personal profile containing passwords, cookies, or active sessions. Launch mode
preserves its explicit executable requirement. `SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH=true`
remains an explicit connect-mode recovery option and still requires an executable.

### Disabled mode

`SMOOTH_OPERATOR_BROWSER_MODE=disabled` keeps the MCP process available for health,
search, protocol, and configuration checks without opening a browser. Browser
tools return a bounded disabled error until the process is restarted with a
browser mode.

## Configuration and precedence

Configuration can come from the installer-created
`~/.smooth-operator/config.json`, an explicitly selected JSON file via `--config`
or `SMOOTH_OPERATOR_CONFIG`, environment variables, and a small set of
command-line flags. When no explicit config path is supplied, the installer
file is loaded automatically so its browser, security, and data-directory
choices apply consistently to every harness. The effective precedence is:

1. command-line values (`--config`, `--transport`, `--host`, `--port`);
2. environment variables;
3. values from the JSON file;
4. documented defaults.

The file is an object with nested `http`, `browser`, and `security` sections.
Explicit `--config`/`SMOOTH_OPERATOR_CONFIG` files reject unknown root keys;
the automatically discovered installer file ignores unrelated root sections so
it can coexist with harness settings. Keep the file owner-readable only
(`chmod 600`); the loader rejects group/world-readable configuration files and
rejects symlinked data directories.

Example:

```json
{
  "transport": "stdio",
  "dataDir": "~/.smooth-operator",
  "browser": {
    "mode": "managed",
    "actionTimeoutMs": 15000
  },
  "security": {
    "allowedDomains": ["example.com", "*.example.org"],
    "blockedDomains": ["admin.example.org"],
    "allowPrivateNetwork": false,
    "allowEval": false
  }
}
```

Environment names correspond to the fields in `.env.example`. Notable
variables include:

| Setting | Default | Notes |
| --- | --- | --- |
| `SMOOTH_OPERATOR_TRANSPORT` | `stdio` | `stdio` or `http` |
| `SMOOTH_OPERATOR_CONFIG` | auto-discovered | Explicit JSON config path; overrides the installer default |
| `SMOOTH_OPERATOR_DATA_DIR` | `~/.smooth-operator` | Private data, file, and download roots |
| `SMOOTH_OPERATOR_BROWSER_MODE` | `managed` | `managed`, `disabled`, `connect`, or `launch` |
| `SMOOTH_OPERATOR_BROWSER_URL` | `http://127.0.0.1:9222` | DevTools HTTP endpoint |
| `SMOOTH_OPERATOR_BROWSER_EXECUTABLE` | unset | Managed-mode override; required for explicit launch mode |
| `SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR` | `${SMOOTH_OPERATOR_DATA_DIR}/browser` | Dedicated persistent browser profile |
| `SMOOTH_OPERATOR_BROWSER_HEADLESS` | `false` | Set `true` for CI/displayless managed or launch use |
| `SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH` / `_HEIGHT` | unset | Set both to apply an explicit viewport |
| `SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH` | `false` | Backward-compatible connect-mode recovery option |
| `SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS` | `15000` | Per-action deadline |
| `SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS` | `30000` | Browser connection deadline |
| `SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS` | `30000` | DevTools command deadline |
| `SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES` | `8000000` | Screenshot byte cap |
| `SMOOTH_OPERATOR_MAX_HTML_CHARS` | `200000` | HTML output cap |
| `SMOOTH_OPERATOR_ALLOWED_DOMAINS` | unset | Comma-separated allowlist |
| `SMOOTH_OPERATOR_BLOCKED_DOMAINS` | unset | Comma-separated denylist |
| `SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS` | data `files`, `downloads` | Explicit roots replace defaults |
| `SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK` | `false` | Allows non-loopback private targets when true |
| `SMOOTH_OPERATOR_ALLOW_EVAL` | `true` | Set `false` to disable page JavaScript |
| `SMOOTH_OPERATOR_STEALTH_ENABLED` | `true` | Set `false` to preserve raw automation signals |
| `SMOOTH_OPERATOR_STEALTH_PROFILE` | `balanced` | `balanced` or `max` compatibility label |
| `SMOOTH_OPERATOR_STEALTH_GPU` | `false` | Adds opt-in GPU launch flags |
| `SMOOTH_OPERATOR_BEHAVIOR_ENABLED` | `true` | Set `false` for fastest raw interactions |
| `SMOOTH_OPERATOR_HTTP_HOST` | `127.0.0.1` | HTTP bind host |
| `SMOOTH_OPERATOR_HTTP_PORT` | `3344` | HTTP bind port |
| `SMOOTH_OPERATOR_HTTP_PATH` | `/mcp` | HTTP endpoint path |
| `SMOOTH_OPERATOR_HTTP_TOKEN` | unset | Required for HTTP; 32+ chars for remote mode |
| `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP` | `false` | Allows non-loopback HTTP only with a strong token |
| `SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES` | `2000000` | Bounded HTTP request body |
| `SMOOTH_OPERATOR_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | HTTP Host allowlist |
| `SMOOTH_OPERATOR_ALLOWED_ORIGINS` | `localhost,127.0.0.1,[::1]` | HTTP Origin allowlist |
| `SMOOTH_OPERATOR_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

### Fast operation mode

The default configuration is a native managed browser with short bounded
behavioral timing, the conservative stealth baseline, and page evaluation
available. For the fastest raw interactions, set
`SMOOTH_OPERATOR_BEHAVIOR_ENABLED=false` and, when appropriate,
`SMOOTH_OPERATOR_STEALTH_ENABLED=false`; set `SMOOTH_OPERATOR_ALLOW_EVAL=false`
when page JavaScript is not needed. Tool calls remain bounded and cancellable;
no hidden planning loop is introduced.

Raw MCP/tool-call speed is not the main bot-detection vector. Sites can score
network and browser identity, IP reputation, session history, and interaction
timing independently. A faster call does not bypass a challenge or make an
automated session legitimate; use the internal AI workflow or human handoff
only where the target permits automation.

## Security enforcement layers

There are no client-selectable permissiveness tiers. The following controls
are always applied, with explicit opt-ins where documented:

- HTTP binds to loopback unless remote mode is enabled and authenticated.
- Navigation is restricted to HTTP(S), rejects embedded credentials, applies
  domain rules, and blocks private/link-local/multicast destinations by default.
- Hostname navigation performs a DNS/private-address preflight and rejects
  redirects that leave policy. The browser's own later DNS resolution is not
  fully controllable by this process; DNS rebinding is therefore a limitation,
  not a guarantee that a network firewall can be omitted.
- New page and worker targets are paused at the DevTools boundary until their
  request guard is installed. HTTP(S) and normalized WS(S) requests receive
  the same policy checks; `about:blank` is allowed, data/blob URLs are limited
  to non-frame subresources, and file, browser-internal, extension, and
  unknown schemes are rejected.
- Upload and PDF destinations must stay within configured file roots after
  realpath and symlink checks. Download paths and generated files are bounded.
- Page JavaScript is available in the native profile by default and can be
  disabled with `SMOOTH_OPERATOR_ALLOW_EVAL=false`; when enabled, page code can
  observe and mutate page state with the browser's privileges.
- Page text, HTML, titles, attributes, search snippets, cookies, and logs are
  treated as untrusted data, normalized, bounded, and redacted before output.
- Challenge and anti-bot markers are reported from bounded evidence. The server
  does not rotate identities or silently bypass challenges. The connected-AI
  challenge loop collects fresh classification and visual/state evidence,
  allows ordinary browser actions, and verifies with a subsequent call.

Run the server with a dedicated browser profile and the smallest domain and
file-root allowlists that fit the task. Browser automation can still perform
irreversible actions on a site; the MCP client and operator remain responsible
for confirming destructive calls.

## MCP capabilities

### Tools

The registry includes these groups of tools. Every input is schema-validated;
individual descriptions and limits are returned by `tools/list`.

**Observation and extraction:** `browser_snapshot`, `browser_tabs`,
`browser_list_tabs`, `browser_list_sessions`, `browser_get_state`,
`browser_page_info`, `browser_interactive`, `browser_frames`,
`browser_accessibility_snapshot`, `browser_extract`, `browser_extract_content`,
`browser_find_text`, `browser_search_page`, `browser_find_elements`,
`browser_dropdown_options`, `browser_computed_style`, `browser_page_next`,
`browser_get_html`, `browser_challenge`, `browser_doctor`, and `server_health`.

**Navigation and interaction:** `browser_navigate`, `browser_back`,
`browser_go_back`, `browser_forward`, `browser_reload`, `browser_switch_tab`,
`browser_close_tab`, `browser_click`, `browser_input`, `browser_select`,
`browser_scroll`, `browser_scroll_to_bottom`, `browser_key`,
`browser_wait`, `browser_wait_for_element`, `browser_wait_for_text`, `browser_wait_for_url`,
`browser_wait_for_network_idle`, `browser_hover`, `browser_move`, `browser_press_and_hold`,
`browser_type`, `browser_close`, and `browser_close_all`.

**Available local capabilities:** `browser_screenshot`, `browser_pdf`,
`browser_upload`, `browser_downloads`, `browser_network_log`,
`browser_console_log`, `browser_dialog`, `browser_cookies`, `browser_storage`,
`browser_batch`, `browser_exec`, `browser_wait_for_human`,
`browser_solve_challenge`, and all other browser tools are available by default.
`browser_close_session` remains a local lifecycle control and does not change
browser permissions. Page evaluation is available by default and can be
disabled explicitly with `SMOOTH_OPERATOR_ALLOW_EVAL=false`.

`browser_evaluate` is page JavaScript and is available by default (set
`SMOOTH_OPERATOR_ALLOW_EVAL=false` when it is not wanted). `browser_exec`
accepts only a JSON array of validated browser actions; it is not a shell,
Python, or arbitrary code runner. Destructive batch actions require explicit
confirmation. `browser_wait_for_human` pauses for an operator to complete a
visible sign-in or challenge. `browser_solve_challenge` is an internal
connected-AI observe/act/verify loop: it returns bounded evidence and is
successful only when a fresh final classification explicitly reports the
challenge absent. `browser_close_session` closes the one native browser session
by its explicit session identifier.

Actions that leave a usable page—navigation, click, input, select, scroll, key,
back, forward, and reload—accept optional `includeSnapshot: true`. The action
result then includes one bounded trailing snapshot with current refs and a DOM
revision. A snapshot failure is reported as `snapshot: null` with a bounded
`snapshotError`; the completed mutation remains a success. `browser_batch`
accepts the same option at the top level and captures only one snapshot after
the final action.

`browser_extract` returns `offset`, `nextOffset`, `hasMore`, and `revision`.
Use `browser_page_next` with the returned offset and revision; a stale revision
returns the retryable `STALE_PAGE_SLICE` error instead of silently overlapping
or skipping text. `browser_search_page` reports `totalMatches` and
`matchesTruncated`. Page slices, matches, evaluate output, network entries,
and research URLs are bounded, redacted, and marked as untrusted data.

Batch inputs accept canonical action names plus compatibility aliases such as
`key`, `select`, `back`, `forward`, `page_info`, `challenge`, `interactive`,
`frames`, `downloads`, `upload`, and `pdf`. Grouped cookie, storage, dialog,
network-log, and console-log operations are normalized before validation;
conflicting alias and canonical fields fail with their action index and field
names. A failed batch preserves bounded completed results and reports
`failedIndex`, `failedAction`, and `completedActions`.

If browser teardown times out or fails, later browser work returns the
retryable `BROWSER_RECOVERY_REQUIRED` error. Call `browser_close_session` to
retry cleanup; the recovery latch clears only after teardown is confirmed.

`web_search` performs bounded DuckDuckGo retrieval. Search titles, URLs, and
snippets are untrusted observations, not instructions or proof of claims. Its
`maxResults` input is capped at 10, and `maxChars` (500–4,000 through the MCP
schema) is one aggregate budget across the returned title and snippet text,
not a per-result multiplier. URL fields and fixed untrusted-data wrapper
markers are outside that text budget. The response body is bounded before
parsing, redirects are rejected, cancellation and timeout are propagated, and
credentials/query secret placeholders are removed from result URLs. Transient
retrieval failures use at most three bounded attempts; anti-bot responses are
reported without attempting a bypass.

### Resources

The server publishes read-only resources:

- `smooth-operator://server/capabilities`
- `smooth-operator://browser/tabs`
- `smooth-operator://browser/page/current`
- `smooth-operator://browser/page/{pageId}`
- `smooth-operator://browser/downloads`
- `smooth-operator://browser/logs/network`
- `smooth-operator://browser/logs/console`

Resource output is bounded and follows the same redaction and policy rules as
tool output. The capabilities resource also reports the native defaults and
effective feature flags for local browser tools, page evaluation, stealth, and
behavioral timing, plus whether challenge success requires an explicit absent
classification.

### Prompts

The user-facing prompt templates are `agent-chrome-setup`, `browser-workflow`,
`extract-page`, and `research-question`. They are short starting points for the
MCP client's own conversation; they are not hidden instructions or a planning
engine.

## Lifecycle and cleanup

At startup the process validates arguments and configuration, creates private
data directories, constructs the runtime, and registers the MCP surface. The
browser is connected or launched only when a browser operation requires it.

On SIGINT/SIGTERM, the server stops accepting HTTP requests, waits for active
requests up to a bounded grace period, closes the MCP transport, closes pages,
and terminates a browser process that it owns. A browser connected in `connect`
mode remains under the operator's ownership.

To clean up a local installation:

```sh
npm uninstall -g smooth-operator-mcp
```

Remove the corresponding `SmoothOperator` entry from a harness config and delete
`SMOOTH_OPERATOR_DATA_DIR` only after preserving any downloads or PDFs you need.
The installer creates owner-only, uniquely named `.bak` files when changing an
existing JSON/JSONC harness config; retain or remove those backups according
to your local recovery policy.

## Troubleshooting

- **No browser tabs:** verify the DevTools URL, that the browser is running,
  and that `SMOOTH_OPERATOR_BROWSER_MODE` is not `disabled`.
- **Launch fails:** provide an executable path and a new writable profile;
  `puppeteer-core` does not download Chrome.
- **HTTP 401/403:** check the bearer token, Host/Origin allowlists, and that
  remote mode was explicitly enabled for a non-loopback bind.
- **Private target blocked:** keep the default deny unless the target is an
  intentional private service, then set `SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK=true`
  and use a narrow domain allowlist.
- **File rejected:** configure an allowed root and use a path beneath it;
  symlink escapes are rejected after resolution.
- **MCP client shows no tools:** inspect stderr separately from stdout, run
  `smooth-operator --version`, and perform a fresh client handshake after
  changing the config.
- **GUI client cannot spawn the server:** use the absolute Node-plus-bundled
  entrypoint form shown above; GUI applications often have a smaller PATH.

For harness-specific CLI syntax, config paths, and the OpenCode interactive
CLI limitation, read [harnesses.md](harnesses.md).
