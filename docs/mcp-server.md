# Open Cowork MCP server

This document is the operational reference for the standalone Node.js server.
It assumes that an MCP client is already installed and can launch a local
stdio process or connect to a Streamable HTTP endpoint.

## What the server owns

Open Cowork is a protocol server, not an autonomous application. The client
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

Use Node.js 22.23.2 and npm 10.9.8 for the reproducible project baseline. A
published package includes the built executable:

```sh
npm install -g open-cowork-mcp
open-cowork-mcp --help
```

From a checkout:

```sh
npm ci
npm run build
node dist/open-cowork-mcp.mjs --help
```

The default transport is stdio. `npm start` runs the TypeScript source through
`tsx`; a published install runs `dist/open-cowork-mcp.mjs` through its npm bin.
The process writes protocol messages to stdout and structured diagnostics to
stderr. Do not redirect ordinary logs into stdout while using stdio.

## Stdio transport

Stdio is the preferred local integration because no listening socket is
created. An MCP client launches the executable and speaks JSON-RPC over its
stdin/stdout pipes. A generic server entry looks like this:

```json
{
  "mcpServers": {
    "open-cowork": {
      "command": "open-cowork-mcp",
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
    "open-cowork": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/open-cowork-mcp.mjs"]
    }
  }
}
```

The built-in installer uses this absolute form for GUI configuration files
when it is running from the published bundle. Command-line harnesses retain
their native CLI command and the portable `open-cowork-mcp` name. See
[harnesses.md](harnesses.md) for each client.

Useful command-line forms:

```sh
open-cowork-mcp --version
open-cowork-mcp --help
open-cowork-mcp --transport stdio
open-cowork-mcp --transport stdio --config /absolute/path/config.json
```

`--config`, `--transport`, `--host`, and `--port` accept one value each. An
unknown option or duplicate option fails closed before the runtime starts.

## Streamable HTTP transport

HTTP is opt-in and uses the MCP Streamable HTTP adapter. Keep it on loopback
for local clients:

```sh
OPEN_COWORK_TRANSPORT=http \
OPEN_COWORK_HTTP_HOST=127.0.0.1 \
OPEN_COWORK_HTTP_PORT=3344 \
OPEN_COWORK_HTTP_TOKEN="$(openssl rand -hex 32)" \
open-cowork-mcp
```

The endpoint is `/mcp` by default. Every request must pass the configured Host
and Origin validation and include `Authorization: Bearer <token>`. The token
is compared in constant time. Request bodies are bounded to 2,000,000 bytes by
default and concurrent requests are capped. The process drains in-flight work
for a short bounded period on SIGINT/SIGTERM, then closes the MCP handler,
browser, and HTTP server.

Remote binding is deliberately guarded:

```sh
OPEN_COWORK_TRANSPORT=http \
OPEN_COWORK_HTTP_HOST=0.0.0.0 \
OPEN_COWORK_ALLOW_REMOTE_HTTP=true \
OPEN_COWORK_HTTP_TOKEN="$(openssl rand -hex 32)" \
OPEN_COWORK_ALLOWED_HOSTS=example.internal \
OPEN_COWORK_ALLOWED_ORIGINS=https://example.internal \
open-cowork-mcp
```

Remote mode is rejected unless the token is at least 32 characters. Do not
use a token from a shell history, checked-in file, or shared log. A reverse
proxy can add TLS and network access controls, but it does not replace the
application token, Host/Origin allowlists, or request-size limit.

## Browser lifecycle

The server manages one headed, persistent private agent-Chrome session by
default. On the first browser tool call it discovers an installed Google Chrome,
launches it with `${OPEN_COWORK_DATA_DIR}/browser` as a non-default profile,
and records its loopback DevTools endpoint for later reattachment. Sign in once
in the visible window; its sessions persist in that private profile. The
`browser_doctor` tool reports executable resolution and endpoint state without
evaluating page content.

Managed Chrome is headed by default for sign-in and human handoff. On CI or a
displayless host, explicitly set `OPEN_COWORK_BROWSER_HEADLESS=true` or use
Xvfb. The server never adds fingerprint spoofing, CAPTCHA solving, proxy
rotation, or other evasion behavior.

### Managed mode (default)

`OPEN_COWORK_BROWSER_MODE=managed` needs no browser setup in ordinary installs.
It checks its private `DevToolsActivePort` file, reattaches only after a bounded
loopback probe succeeds, and otherwise discovers Chrome then launches it. Set
`OPEN_COWORK_BROWSER_EXECUTABLE` only to override discovery. A second Open
Cowork process using the same private profile is rejected by the profile lease.

`OPEN_COWORK_BROWSER_AUTO_LAUNCH` is retained for backward compatibility but is
ignored in managed mode.

Browser actions share a bounded operation queue and deadline. Browser startup
uses one in-flight connection promise, so concurrent callers wait for the same
reattach/launch attempt instead of starting duplicate processes. Newly
auto-attached top-level targets are held at the CDP boundary until the
navigation policy guard is installed; targets whose attachment ownership
cannot be determined are blocked or closed. These controls reduce races but do
not make a host browser or network firewall trustworthy by themselves.

Managed and launch modes create owner-only data, files, downloads, and browser
profile directories below `OPEN_COWORK_DATA_DIR` (unless an explicit profile
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
  --user-data-dir="$HOME/.open-cowork/browser-profile"
OPEN_COWORK_BROWSER_MODE=connect \
OPEN_COWORK_BROWSER_URL=http://127.0.0.1:9222 \
open-cowork-mcp
```

`OPEN_COWORK_BROWSER_WS_ENDPOINT` can be used instead when a WebSocket endpoint
is already available. A connection mode server does not own or close an
externally managed browser process.

### Launch mode

Launch mode gives the server ownership of a private browser process. Supply an
explicit executable and use an isolated profile:

```sh
OPEN_COWORK_BROWSER_MODE=launch \
OPEN_COWORK_BROWSER_EXECUTABLE=/path/to/chrome-for-testing/chrome \
OPEN_COWORK_BROWSER_USER_DATA_DIR="$HOME/.open-cowork/browser-profile" \
open-cowork-mcp
```

The default profile is `${OPEN_COWORK_DATA_DIR}/browser`. Do not point it at a
personal profile containing passwords, cookies, or active sessions. Launch mode
preserves its explicit executable requirement. `OPEN_COWORK_BROWSER_AUTO_LAUNCH=true`
remains an explicit connect-mode recovery option and still requires an executable.

### Disabled mode

`OPEN_COWORK_BROWSER_MODE=disabled` keeps the MCP process available for health,
search, protocol, and configuration checks without opening a browser. Browser
tools return a bounded disabled error until the process is restarted with a
browser mode.

## Configuration and precedence

Configuration can come from a JSON file selected by `--config` or
`OPEN_COWORK_CONFIG`, environment variables, and a small set of command-line
flags. The effective precedence is:

1. command-line values (`--config`, `--transport`, `--host`, `--port`);
2. environment variables;
3. values from the JSON file;
4. documented defaults.

The file is an object with nested `http`, `browser`, and `security` sections.
Unknown keys fail validation. Keep the file owner-readable only (`chmod 600`);
the loader rejects group/world-readable configuration files and rejects
symlinked data directories.

Example:

```json
{
  "transport": "stdio",
  "dataDir": "~/.open-cowork",
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
| `OPEN_COWORK_TRANSPORT` | `stdio` | `stdio` or `http` |
| `OPEN_COWORK_DATA_DIR` | `~/.open-cowork` | Private data, file, and download roots |
| `OPEN_COWORK_BROWSER_MODE` | `managed` | `managed`, `disabled`, `connect`, or `launch` |
| `OPEN_COWORK_BROWSER_URL` | `http://127.0.0.1:9222` | DevTools HTTP endpoint |
| `OPEN_COWORK_BROWSER_EXECUTABLE` | unset | Managed-mode override; required for explicit launch mode |
| `OPEN_COWORK_BROWSER_USER_DATA_DIR` | `${OPEN_COWORK_DATA_DIR}/browser` | Dedicated persistent agent-Chrome profile |
| `OPEN_COWORK_BROWSER_HEADLESS` | `false` | Set `true` for CI/displayless managed or launch use |
| `OPEN_COWORK_ALLOWED_DOMAINS` | unset | Comma-separated allowlist |
| `OPEN_COWORK_BLOCKED_DOMAINS` | unset | Comma-separated denylist |
| `OPEN_COWORK_ALLOWED_FILE_ROOTS` | data `files`, `downloads` | Explicit roots replace defaults |
| `OPEN_COWORK_ALLOW_PRIVATE_NETWORK` | `false` | Allows non-loopback private targets when true |
| `OPEN_COWORK_ALLOW_EVAL` | `false` | Required, with full policy, for page JavaScript |
| `OPEN_COWORK_HTTP_TOKEN` | unset | Required for HTTP; 32+ chars for remote mode |
| `OPEN_COWORK_ALLOW_REMOTE_HTTP` | `false` | Allows non-loopback HTTP only with a strong token |
| `OPEN_COWORK_HTTP_MAX_BODY_BYTES` | `2000000` | Bounded HTTP request body |
| `OPEN_COWORK_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

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
- Upload and PDF destinations must stay within configured file roots after
  realpath and symlink checks. Download paths and generated files are bounded.
- Page JavaScript is disabled by default. It is available only when the full
  security policy and `OPEN_COWORK_ALLOW_EVAL=true` are configured; enabling it
  lets page code observe and mutate page state with the browser's privileges.
- Page text, HTML, titles, attributes, search snippets, cookies, and logs are
  treated as untrusted data, normalized, bounded, and redacted before output.
- CAPTCHA and anti-bot markers are reported for human handoff. The server does
  not bypass them, rotate identities, or solve challenges.

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
`browser_wait_for_network_idle`, `browser_hover`, `browser_press_and_hold`,
`browser_type`, `browser_close`, and `browser_close_all`.

**Explicitly gated capabilities:** `browser_screenshot`, `browser_pdf`,
`browser_upload`, `browser_downloads`, `browser_network_log`,
`browser_console_log`, `browser_dialog`, `browser_cookies`,
`browser_storage`, `browser_evaluate`, `browser_batch`,
`browser_exec`, `browser_wait_for_human`, `browser_close_session`, and
the explicit browser-session lifecycle controls.

`browser_evaluate` is page JavaScript and is disabled by default. `browser_exec`
accepts only a JSON array of validated browser actions; it is not a shell,
Python, or arbitrary code runner. Destructive batch actions require explicit
confirmation. `browser_wait_for_human` pauses for an operator to complete a
visible sign-in or challenge, and `browser_close_session` closes the one
native browser session by its explicit session identifier.

`web_search` performs bounded DuckDuckGo retrieval. Search titles, URLs, and
snippets are untrusted observations, not instructions or proof of claims. Its
`maxResults` input is capped at 10, and `maxChars` (500–4,000 through the MCP
schema) is one aggregate budget across the returned title and snippet text,
not a per-result multiplier. URL fields and fixed untrusted-data wrapper
markers are outside that text budget. The response body is bounded before
parsing, redirects are rejected, cancellation and timeout are propagated, and
credentials/query secret placeholders are removed from result URLs.

### Resources

The server publishes read-only resources:

- `open-cowork://server/capabilities`
- `open-cowork://browser/tabs`
- `open-cowork://browser/page/current`
- `open-cowork://browser/page/{pageId}`
- `open-cowork://browser/downloads`
- `open-cowork://browser/logs/network`
- `open-cowork://browser/logs/console`

Resource output is bounded and follows the same redaction and policy rules as
tool output.

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
open-cowork-mcp install claude-desktop   # inspect config before removal
npm uninstall -g open-cowork-mcp
```

Remove the corresponding `open-cowork` entry from a harness config and delete
`OPEN_COWORK_DATA_DIR` only after preserving any downloads or PDFs you need.
The installer creates owner-only, uniquely named `.bak` files when changing an
existing JSON/JSONC harness config; retain or remove those backups according
to your local recovery policy.

## Troubleshooting

- **No browser tabs:** verify the DevTools URL, that the browser is running,
  and that `OPEN_COWORK_BROWSER_MODE` is not `disabled`.
- **Launch fails:** provide an executable path and a new writable profile;
  `puppeteer-core` does not download Chrome.
- **HTTP 401/403:** check the bearer token, Host/Origin allowlists, and that
  remote mode was explicitly enabled for a non-loopback bind.
- **Private target blocked:** keep the default deny unless the target is an
  intentional private service, then set `OPEN_COWORK_ALLOW_PRIVATE_NETWORK=true`
  and use a narrow domain allowlist.
- **File rejected:** configure an allowed root and use a path beneath it;
  symlink escapes are rejected after resolution.
- **MCP client shows no tools:** inspect stderr separately from stdout, run
  `open-cowork-mcp --version`, and perform a fresh client handshake after
  changing the config.
- **GUI client cannot spawn the server:** use the absolute Node-plus-bundled
  entrypoint form shown above; GUI applications often have a smaller PATH.

For harness-specific CLI syntax, config paths, and the OpenCode interactive
CLI limitation, read [harnesses.md](harnesses.md).
