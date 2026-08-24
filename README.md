# Open Cowork MCP

Open Cowork is a lightweight, standalone Model Context Protocol server for
secure browser automation. The connected MCP client supplies reasoning; this
process exposes explicit, validated browser, search, resource, and prompt
capabilities over the protocol.

The package is intentionally focused: it owns the Node.js server, a Puppeteer /
Chrome DevTools Protocol browser connection, and bounded HTTP retrieval. It
does not select a model or transmit page data to a model service on its own.

## Quick start

Requirements: Node.js 22.23.2 or newer and npm 10.9.8 or newer. The
repository `.nvmrc` pins the reproducible validation baseline.

~~~sh
npm ci
npm run typecheck
npm test
npm start
~~~

For a complete protocol, lifecycle, configuration, and security reference, see
[the MCP server guide](docs/mcp-server.md). For harness-specific registration
commands and configuration paths, see [harness installation](docs/harnesses.md).

After building or installing the package, the installer can register the
stdio server with these harnesses:

~~~sh
npm install -g . && open-cowork-mcp install claude-code
npm install -g . && open-cowork-mcp install opencode
npm install -g . && open-cowork-mcp install copilot
npm install -g . && open-cowork-mcp install codex
npm install -g . && open-cowork-mcp install gemini
npm install -g . && open-cowork-mcp install vscode
~~~

OpenCode is configured by the installer through its documented JSON/JSONC
configuration file because the current `opencode mcp add` command is
interactive. The installer never sends an unsupported command tail to
OpenCode; see the harness guide for the schema and manual fallback.

The default transport is stdio. A client configuration can launch it with:

~~~json
{
  "mcpServers": {
    "open-cowork": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/open-cowork-mcp", "start"]
    }
  }
}
~~~

## Browser connection

Open Cowork starts a headed, persistent private **agent Chrome** on the first
browser tool call. No browser environment variables or manual debugging setup
are needed: it discovers an installed Google Chrome, creates the private
profile at `${OPEN_COWORK_DATA_DIR}/browser`, and reattaches to a live instance
from that profile when possible. Sign in once in the opened window; its browser
sessions stay in that private profile. Use `browser_doctor` to inspect the
resolved executable and local connection health.

Chrome is headed by default so a person can complete sign-in and challenge
handoff. CI or displayless hosts should explicitly set
`OPEN_COWORK_BROWSER_HEADLESS=true` (or supply Xvfb).

### Advanced connection routes

**Managed (default).** `OPEN_COWORK_BROWSER_MODE=managed` is the zero-setup
route described above. Set `OPEN_COWORK_BROWSER_EXECUTABLE` only when Chrome is
installed somewhere outside the standard discovery paths.

**Chrome inspect on a daily profile.** Chrome 144+ can expose an opt-in
inspection route through `chrome://inspect`. Enable its remote-debugging toggle
in that Chrome instance, then attach with `OPEN_COWORK_BROWSER_MODE=connect`
and the endpoint shown there. This is an advanced opt-in path; use it only when
you intentionally want Open Cowork to control that profile.

**Classic DevTools port.** Start a dedicated browser with a non-default profile
directory (required by modern Chrome remote debugging), then explicitly select
connect mode:

~~~sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.open-cowork/browser-profile"
OPEN_COWORK_BROWSER_MODE=connect OPEN_COWORK_BROWSER_URL=http://127.0.0.1:9222 \
npm start
~~~

**Explicit launch.** `launch` remains available when you need a particular
Chromium-compatible binary and profile:

~~~sh
OPEN_COWORK_BROWSER_MODE=launch OPEN_COWORK_BROWSER_EXECUTABLE=/path/to/chrome \
OPEN_COWORK_BROWSER_USER_DATA_DIR="$HOME/.open-cowork/browser-profile" npm start
~~~

Set OPEN_COWORK_BROWSER_MODE=disabled to run the MCP server without browser
access, for health checks and protocol integration.

The server uses one native browser profile and preserves the browser's real
identity. It applies a request-level navigation policy to HTTP(S) browser
requests, with explicit checks for click/script/history/frame navigations. It
does not contain identity rotation, CAPTCHA solving, fingerprint spoofing, or
anti-bot bypass logic; challenge pages are surfaced for user handoff.

## HTTP transport

~~~sh
OPEN_COWORK_TRANSPORT=http OPEN_COWORK_HTTP_PORT=3344 OPEN_COWORK_HTTP_TOKEN="$(openssl rand -hex 32)" npm start
~~~

HTTP binds to 127.0.0.1 by default. Remote binding requires
OPEN_COWORK_ALLOW_REMOTE_HTTP=true and a bearer token of at least 32
characters. Host and Origin allowlists are validated before the MCP handler,
and request bodies are bounded by OPEN_COWORK_HTTP_MAX_BODY_BYTES (2 MB by
default).

## MCP surface

Tools are grouped by responsibility:

- browser_snapshot, browser_tabs, browser_page_info, browser_interactive,
  browser_frames, browser_accessibility_snapshot,
  browser_extract, browser_find_text, browser_search_page,
  browser_find_elements, browser_dropdown_options, browser_computed_style,
  browser_page_next, browser_get_html, browser_get_state, and
  browser_challenge read browser state.
- browser_navigate, browser_back, browser_go_back, browser_forward,
  browser_reload, browser_switch_tab, browser_close_tab,
  browser_click, browser_input, browser_select, browser_scroll,
  browser_scroll_to_bottom, browser_key, browser_wait*,
  browser_hover, browser_press_and_hold, browser_type, browser_close, and
  browser_close_all
  interact with the browser.
- browser_screenshot (including browser-use CLI `full` and `max_dim` aliases), browser_pdf, browser_upload, browser_downloads,
  browser_network_log, browser_console_log, browser_dialog, browser_cookies,
  and browser_storage expose explicitly gated privileged capabilities.
- browser_evaluate is disabled by default. browser_batch runs up to 50
  validated actions without an internal planner.
- browser_wait_for_human waits for a user to complete a visible challenge or
  sign-in step. browser_exec accepts explicit JSON action plans only; this
  server intentionally embeds no model service or arbitrary Python/JavaScript
  executor.
- browser_extract_content is a deterministic compatibility alias for bounded
  extraction; it does not call an LLM.
- browser_list_tabs is an explicit browser-use naming alias for browser_tabs.
- web_search performs bounded DuckDuckGo retrieval and marks source text as
  untrusted.
- server_health returns public runtime status; browser_doctor reports local
  managed-browser discovery and endpoint health.

`web_search` accepts `maxResults` (1–10) and `maxChars` (500–4,000). The latter
is one aggregate character budget across all returned title and snippet text;
it is not multiplied by the result count. URL metadata and the fixed
`<untrusted_…>` wrapper markers are outside that text budget. Responses are
bounded before parsing, redirects fail closed, and result URLs are normalized
and redacted before they leave the server.

Resources:

- open-cowork://server/capabilities
- open-cowork://browser/tabs
- open-cowork://browser/page/current
- open-cowork://browser/page/{pageId}
- open-cowork://browser/downloads
- open-cowork://browser/logs/network
- open-cowork://browser/logs/console

Prompts are small, user-facing templates rather than hidden system prompts:
agent-chrome-setup, browser-workflow, extract-page, and research-question.

## Configuration

Every setting can be supplied through environment variables or a JSON file
passed with --config. JSON configuration files must not be group/world
readable; use `chmod 600` for the usual owner-only setup. The runtime also
rejects symlinked data directories and creates its files/downloads directories
with owner-only permissions.

| Variable | Default | Purpose |
| --- | --- | --- |
| OPEN_COWORK_TRANSPORT | stdio | stdio or http |
| OPEN_COWORK_DATA_DIR | ~/.open-cowork | Download/file roots and runtime data |
| OPEN_COWORK_BROWSER_MODE | managed | managed, disabled, connect, or launch |
| OPEN_COWORK_BROWSER_URL | http://127.0.0.1:9222 | DevTools HTTP endpoint |
| OPEN_COWORK_BROWSER_WS_ENDPOINT | unset | DevTools WebSocket endpoint |
| OPEN_COWORK_BROWSER_EXECUTABLE | unset | Explicit Chrome executable; managed mode otherwise discovers Google Chrome |
| OPEN_COWORK_BROWSER_USER_DATA_DIR | `${OPEN_COWORK_DATA_DIR}/browser` | Dedicated persistent agent-Chrome profile directory |
| OPEN_COWORK_BROWSER_HEADLESS | false | Managed/launch headless setting; set true for CI |
| OPEN_COWORK_BROWSER_TIMEOUT_MS | 15000 | Browser action/navigation timeout |
| OPEN_COWORK_BROWSER_CONNECT_TIMEOUT_MS | 30000 | Bounded browser launch/CDP connection deadline |
| OPEN_COWORK_BROWSER_CDP_TIMEOUT_MS | 30000 | Bounded Chrome DevTools operation deadline |
| OPEN_COWORK_MAX_SCREENSHOT_BYTES | 8000000 | Screenshot output limit |
| OPEN_COWORK_MAX_HTML_CHARS | 200000 | HTML and page-text output limit |
| OPEN_COWORK_ALLOWED_DOMAINS | unset | Optional comma-separated allowlist |
| OPEN_COWORK_BLOCKED_DOMAINS | unset | Comma-separated denylist |
| OPEN_COWORK_ALLOWED_FILE_ROOTS | data dir `files` and `downloads` | Comma-separated upload/output roots; explicit roots replace the defaults |
| OPEN_COWORK_ALLOW_PRIVATE_NETWORK | false | Allow non-loopback private targets |
| OPEN_COWORK_ALLOW_EVAL | false | Explicitly enable page JavaScript |
| OPEN_COWORK_HTTP_TOKEN | unset | Bearer token for HTTP |
| OPEN_COWORK_ALLOW_REMOTE_HTTP | false | Permit non-loopback HTTP binding |
| OPEN_COWORK_HTTP_MAX_BODY_BYTES | 2000000 | Maximum buffered MCP HTTP request body |
| OPEN_COWORK_LOG_LEVEL | info | debug, info, warn, or error |

There is one server capability profile. Safety is enforced as independent
layers rather than as a client-selectable permissiveness switch: transport
authentication, navigation and DNS checks, file-root checks, output bounds,
redaction, and the separate page-JavaScript opt-in are applied at the service
boundary. `OPEN_COWORK_BROWSER_MODE=disabled` is a browser-availability mode,
not a way to bypass any other policy.

## Architecture

~~~text
MCP client
   |
   +-- stdio or Streamable HTTP transport
             |
             +-- MCP registry (tools/resources/prompts)
                       |
                       +-- ServerRuntime
                              +-- SecurityPolicy
                              +-- BrowserService (Puppeteer/CDP)
                              +-- ResearchService (bounded HTTP)
                              +-- Logger and safe error boundary
~~~

The server does not call a model service. This keeps startup fast, avoids
model credentials in the server, and makes each
side effect visible as a normal MCP tool call.

## Development

~~~sh
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run package:smoke

# Opt-in only: requires a local Chrome/Chromium executable.
npm run test:browser:live
~~~

The build emits dist/open-cowork-mcp.mjs. Generated output is ignored.

`npm run package:smoke` builds a temporary npm tarball and verifies its
allowlisted contents, documentation links, version relationship, executable,
and external sourcemap. It does not commit `dist/`, `coverage/`, or a tarball.
The ordinary suite skips live browser tests when no executable is configured;
`npm run test:browser:live` discovers a preinstalled Chrome (or honors
`OPEN_COWORK_TEST_BROWSER_EXECUTABLE`) and fails clearly when none is available.
The hosted Linux CI job opts into that script, so its managed-browser checks do
not silently remain skipped.

## Security notes

- Browser navigation accepts only HTTP and HTTPS URLs without embedded
  credentials.
- Domain allowlists and denylists are applied before navigation and search;
  hostname research requests also perform an asynchronous DNS/private-address
  preflight and reject redirects.
- Main-frame navigations are checked again at the DevTools request boundary,
  including navigations initiated by links, scripts, and history controls.
- Private and loopback targets are distinguished; non-loopback private targets
  are blocked by default.
- Uploads and PDF paths are checked against configured roots and resolved again
  after symlink resolution.
- Page text, HTML-derived attributes, search snippets, and log URLs are
  bounded, normalized, and redacted. Untrusted page content is wrapped with
  an explicit data marker.
- HTTP authorization uses a constant-time bearer-token comparison.
- Logs are JSON on stderr and never contain configured secret values.
- CAPTCHA detection reports markers only; the server does not bypass challenges.
- Open shadow roots can be queried with Puppeteer's explicit `pierce/` selector
  prefix; closed shadow roots are intentionally not exposed.

The DNS check is a best-effort application-layer SSRF defense, not a network
firewall. A hostname can change its DNS answer after the preflight, and the
browser or operating system may resolve it independently. For high-risk
networks, pair the server policy with network egress controls and a dedicated
browser profile.

## Project layout

~~~text
src/server/main.ts
src/server/mcp.ts
src/server/runtime.ts
src/server/browser/service.ts
src/server/config.ts
src/server/contracts.ts
src/server/policy.ts
src/server/research.ts
src/server/security.ts
src/server/logger.ts
src/server/errors.ts
src/server/version.ts
tests/
docs/mcp-server.md
docs/harnesses.md
~~~

See docs/mcp-server.md for the complete tool contract, lifecycle behavior,
configuration file format, and server integration points.
