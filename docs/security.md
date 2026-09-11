# Security

Fail closed. Bound and redact untrusted page, search, and log data. Dual-enforce
the same `SecurityPolicy` at the MCP edge and again at the browser/research
service.

## Network

- HTTP(S) only. Credentials in URLs are rejected. Untrusted URL credentials are redacted in output.
- Redirects are re-checked with the same policy and fail closed. Research fetch uses `redirect: "error"`.
- Private, link-local, and multicast addresses are blocked unless `SMOOTH_OPERATOR_ALLOW_PRIVATE_NETWORK=true`. Loopback is allowed.
- DNS is a best-effort preflight (deny-only cache). The browser resolver is not pinned.
- Resource blocking is page-scoped to image, stylesheet, font, media, and script. Document/navigation cannot be selected.

## Files

- Allowed roots are canonicalized once. Filesystem-root roots and regular-file roots are rejected.
- Unresolved symlink escapes fail closed. Blocked-path errors include only configured-root metadata.
- Uploads: at most 20 files, 50 MiB each, 100 MiB aggregate; every staging path is cleaned on all outcomes. Multiple files require `multiple` on the input.
- Config files and backups are bounded, owner-only (`chmod 600`), regular, and symlink-safe. Writes use a temp file, flush, then atomic rename.

## Page data

Returned HTML, text, accessibility, inspect, cookies, and storage omit:

- scripts and event-handler attributes
- form values (including accessibility descendants)
- cookie values on read
- secret placeholders, bearer-shaped strings, and secret query keys

Truncation is explicit (`truncated`, `mcpOutputTruncated`, `*Truncated`, omission counts). Silent omission is a bug.

Page evaluation is on by default and gated by `SecurityPolicy.assertEvalAllowed()` at the MCP edge and again in `BrowserService`. There is no generic CDP or host-code tool.

## HTTP

- Loopback bind unless remote HTTP is explicitly enabled.
- Remote HTTP requires a token of at least 32 printable ASCII characters.
- Host and Origin are parsed and allowlisted. Bearer comparison is constant-time.
- `healthz` uses the same Host/Origin/bearer policy as `/mcp`.
- Bodies are capped (default 2 MiB). Malformed or partial responses close the connection.

## Browser process

- One profile lease (`.smooth-operator-profile.lock`). Concurrent sessions fail with `BROWSER_PROFILE_IN_USE`.
- Managed and launch require a regular executable, a bounded 64 KiB `/json/version` probe, and target auto-attach acknowledgement.
- Connect mode attaches to the configured `browserURL` / `wsEndpoint`. The wizard Personal Chrome helper uses `~/.smooth-operator/personal-chrome` and does not take over daily Chrome. Advanced `chrome://inspect` attach to a daily profile is opt-in; see [mcp-server.md](mcp-server.md).
- After an uncooperative timeout the old lifecycle is retired before the queue advances. A late close cannot release another request's lock.

## Challenges and research

Challenges are classified from independently bounded title, text, HTML, frame, and visible-marker evidence. The connected harness loops `browser_solve_challenge` / `browser_wait_for_human`. Success requires a fresh classification that is explicitly **absent**. There is no solver, token injection, or anti-bot bypass. Identity stays native: launch args do not fabricate UA, platform, WebGL, canvas, client hints, or `navigator.webdriver`.

`web_search` is bounded DuckDuckGo HTML. Anti-bot responses are `SEARCH_BLOCKED`. The server does not complete challenges for the search provider.

## Logs

JSON lines on stderr. Secret keys and values are redacted. Logging failures never change protocol responses.
