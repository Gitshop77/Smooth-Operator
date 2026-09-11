# Configuration

Environment variables or `--config` JSON (`chmod 600`, no symlinks).
Comma-separated lists reject more than 128 entries before normalization.

| Variable | Default | Purpose |
|---|---|---|
| `SMOOTH_OPERATOR_TRANSPORT` | `stdio` | `stdio` or `http` |
| `SMOOTH_OPERATOR_CONFIG` | auto `~/.smooth-operator/config.json` | Explicit JSON path |
| `SMOOTH_OPERATOR_DATA_DIR` | `~/.smooth-operator` | Data root |
| `SMOOTH_OPERATOR_BROWSER_MODE` | `managed` | `managed` / `connect` / `launch` / `disabled` |
| `SMOOTH_OPERATOR_BROWSER_URL` | `http://127.0.0.1:9222` | DevTools HTTP endpoint |
| `SMOOTH_OPERATOR_BROWSER_WS_ENDPOINT` | unset | DevTools WebSocket endpoint |
| `SMOOTH_OPERATOR_BROWSER_EXECUTABLE` | unset | Chromium binary (required for `launch`) |
| `SMOOTH_OPERATOR_BROWSER_USER_DATA_DIR` | `${DATA_DIR}/browser` | Persistent profile |
| `SMOOTH_OPERATOR_BROWSER_HEADLESS` | `false` | Headless Chrome |
| `SMOOTH_OPERATOR_BROWSER_VIEWPORT_WIDTH` / `_HEIGHT` | unset | Set both for an explicit viewport |
| `SMOOTH_OPERATOR_BROWSER_AUTO_LAUNCH` | `false` | Legacy connect-mode recovery launch |
| `SMOOTH_OPERATOR_BROWSER_TIMEOUT_MS` | `15000` | Action timeout |
| `SMOOTH_OPERATOR_BROWSER_CONNECT_TIMEOUT_MS` | `30000` | Connect timeout |
| `SMOOTH_OPERATOR_BROWSER_CDP_TIMEOUT_MS` | `30000` | CDP timeout |
| `SMOOTH_OPERATOR_BROWSER_IDLE_TIMEOUT_MS` | `0` | Idle cleanup; `0` disabled, max 24 hours |
| `SMOOTH_OPERATOR_MAX_SCREENSHOT_BYTES` | `8000000` | Screenshot cap |
| `SMOOTH_OPERATOR_MAX_HTML_CHARS` | `200000` | HTML cap |
| `SMOOTH_OPERATOR_ALLOWED_DOMAINS` | unset | Hostname allowlist (`*.` suffix ok) |
| `SMOOTH_OPERATOR_BLOCKED_DOMAINS` | unset | Hostname denylist |
| `SMOOTH_OPERATOR_ALLOWED_FILE_ROOTS` | `files`,`downloads` | Upload/PDF roots |
| `SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK` | `false` | Non-loopback private targets |
| `SMOOTH_OPERATOR_ALLOW_EVAL` | `true` | Page JavaScript |
| `SMOOTH_OPERATOR_STEALTH_ENABLED` | `true` | Compatibility label; identity stays native |
| `SMOOTH_OPERATOR_STEALTH_PROFILE` | `balanced` | `balanced` or `max`; no patch-set difference |
| `SMOOTH_OPERATOR_STEALTH_GPU` | `false` | Opt-in GPU flags |
| `SMOOTH_OPERATOR_BEHAVIOR_ENABLED` | `false` | Opt-in timing wrappers |
| `SMOOTH_OPERATOR_HTTP_HOST` | `127.0.0.1` | HTTP bind host |
| `SMOOTH_OPERATOR_HTTP_PORT` | `3344` | HTTP bind port |
| `SMOOTH_OPERATOR_HTTP_PATH` | `/mcp` | MCP path; health is `<path>/healthz` |
| `SMOOTH_OPERATOR_HTTP_TOKEN` | unset | Bearer token |
| `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP` | `false` | Non-loopback HTTP |
| `SMOOTH_OPERATOR_HTTP_MAX_BODY_BYTES` | `2000000` | Body cap |
| `SMOOTH_OPERATOR_ALLOWED_HOSTS` / `_ORIGINS` | localhost, loopback | HTTP allowlists |
| `SMOOTH_OPERATOR_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Removed (fail closed if set): `SMOOTH_OPERATOR_BROWSER_PROFILE`,
`SMOOTH_OPERATOR_BROWSER_STEALTH`, `SMOOTH_OPERATOR_DEFAULT_MODE`,
`SMOOTH_OPERATOR_BROWSER_USER_AGENT`.

CLI: `smooth-operator [server] [--transport stdio|http] [--config path] [--host host] [--port port]`,
`smooth-operator install [harness] --yes`, `smooth-operator doctor`.

The wizard asks exactly three questions: browser profile ownership, browser
display, and the Chromium executable. `--yes` uses managed, headed, eval on,
native-identity compatibility, and deterministic input.

See `.env.example` for a copy-paste template.
