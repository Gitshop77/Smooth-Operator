# SmoothOperator — Verified Optimization and Hardening Plan

**Target release:** 2.4.0

**Compatibility policy:** Backward-compatible within the 2.x line
**Priority order:** Security → recovery → correctness → round trips → measured latency → delivery

## 1. Objective and engineering rules

Strengthen SmoothOperator without weakening its fail-closed security model or breaking existing MCP clients. Preserve the current advantages—bounded outputs, deterministic browser actions, stable refs, batching, an isolated persistent profile, and no embedded model loop—while fixing verified security and reliability gaps and reducing measured browser and MCP round trips.

Apply these rules to every change:

1. Start with a failing regression test, reproducible benchmark, or explicit contract test.
2. Preserve all 59 existing MCP tool names and existing result fields throughout 2.x.
3. Make public contract additions optional and default them to current behavior.
4. Retain both serialized text content and `structuredContent`. The MCP specification recommends both for backward compatibility: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>.
5. Never cache successful URL, DNS, redirect, or file-policy decisions in a way that can bypass revalidation.
6. Accept a performance change only when its target median improves by at least 10% and p95 does not regress by more than 10%.
7. Keep each phase independently reviewable and releasable. Do not combine unrelated capability expansion with hardening work.

## 2. Verified baseline

The following baseline was recorded before implementation:

- Package: `smooth-operator-mcp@2.3.1`.
- Public surface: 59 MCP tools and 61 canonical internal browser actions.
- Quality gate: lint, typecheck, dead-code analysis, and build pass.
- Tests: 202 pass and 2 are skipped.
- Coverage: 64.31% lines overall; `browser/service.ts` is 50.49%.
- Disabled-browser benchmark, 10 cold processes:
  - Source startup median: approximately 365 ms.
  - Bundled startup median: approximately 193 ms.
  - `tools/list` payload: 49,010 bytes.
- The T1–T7 comparison observed 22 SmoothOperator calls for 7 completed tasks versus 44 competitor calls for 6.5 tasks. It did not measure wall-clock time, model tokens, or headless parity, so those are not release claims.
- A local live-browser run was unavailable because Chrome/Chromium was not installed. The Linux CI live-browser job is therefore mandatory before release.

## 3. Phase 0 — Reproducible gates and contract lock

Complete this phase before modifying browser behavior.

### Benchmark harness

- Extend `scripts/benchmark-mcp.mjs` to support up to 30 iterations and an optional JSON output path.
- Report median, p95, output bytes, failures, and status mismatches for every probe.
- Maintain four baselines: source/disabled, bundle/disabled, source/live, and bundle/live.
- Extend the deterministic live fixture to measure navigation, snapshot, click, input, page lookup, pagination, a 10-step batch, cooperative cancellation, and ignored cancellation.
- Add test-only counters around browser/page/CDP calls so changes can prove round-trip reductions without relying only on wall-clock timing.
- Upload benchmark JSON as a CI artifact. Do not make timing release-blocking until repeated CI runs establish stable variance.

### Public contract lock

- Add a contract snapshot covering tool names, titles, input schemas, annotations, resources, prompts, and representative success/error envelopes.
- Assert that text content remains the serialized fallback for `structuredContent`.
- Treat removals, required new fields, and changed existing field types as failures.
- Permit optional fields and accepted input aliases to be added.

### Exit criteria

- Thirty-iteration disabled baselines are recorded.
- Live baseline runs successfully in CI.
- Contract snapshots fail on accidental 2.x breaking changes.

## 4. Phase 1 — Network and file security boundaries

### Worker request interception

The page interception path does not cover all requests initiated by service and shared workers. Extend the existing pre-resume CDP guard instead of relying on the later `targetcreated` event.

- Recursively auto-attach to `page`, `service_worker`, and `shared_worker` targets.
- Keep each target paused until Fetch interception is enabled, then call `Runtime.runIfWaitingForDebugger`.
- Retain Fetch interception for the full worker lifetime.
- Let page targets transition to Puppeteer page interception only after their guarded requests have drained.
- Track session detach/disconnect and remove listeners and pending request records deterministically.
- Close the target when attachment ownership, Fetch installation, or pre-resume guarding cannot be confirmed.

### Scheme policy

Use one explicit scheme policy in the new-target and page-request paths:

- Permit HTTP and HTTPS only after normal domain, credential, DNS, private-network, and redirect validation.
- Normalize `ws:`/`wss:` to HTTP/HTTPS and apply the same policy.
- Permit `about:blank`.
- Permit `data:` and `blob:` only for non-frame subresources.
- Reject `file:`, `filesystem:`, `chrome:`, `devtools:`, browser-extension schemes, and every unknown scheme.
- Preserve policy rechecking at redirects and the DevTools boundary.

### Upload TOCTOU protection

- Resolve the source inside an allowed root and reject symlinks as today.
- Open the source and verify that the opened handle is a regular file.
- Compare handle identity with a post-open `lstat`; reject a symlink or replacement race.
- Stream the opened handle into an exclusive 0600 staging file under the private data directory.
- Upload only the staging file and remove it in `finally`, including cancellation and browser failure paths.
- Preserve existing source-path and filename redaction in protocol responses and logs.

### HTTP boundary hardening

- Hash expected and presented bearer tokens with SHA-256 before constant-time comparison.
- Add a 30-second total deadline while reading a request body.
- Continue enforcing the configured byte limit while streaming.
- On timeout or size violation, stop retaining data, return a bounded 408/413-style application response, and close the connection so the concurrency slot is released.

### Required tests

- A service worker and shared worker fetch a blocked hostname; the destination server records zero requests.
- Allowed worker HTTP/HTTPS requests complete.
- Worker redirects are rechecked.
- Unsupported worker interception closes the target before its request executes.
- `file:` and unknown schemes are rejected for pages, frames, workers, and subresources.
- Allowed non-frame `data:` and `blob:` resources continue to work.
- Swapping an upload source with a symlink or different file cannot change uploaded bytes.
- Slow and oversized HTTP bodies release their request slots.

## 5. Phase 2 — Cancellation, timeout, and queue recovery

Keep the single serialized browser-operation lane in 2.4.0. Improve recovery without adding cross-tab concurrency.

### Recovery algorithm

1. When a request is cancelled or reaches its operation deadline, abort its operation controller.
2. Allow 250 ms for cooperative settlement.
3. If the operation settles during that grace period, release the queue normally and retain the browser and other tabs.
4. If it does not settle:
   - Increment the lifecycle generation and retire all states associated with the old connection.
   - Close an owned browser or disconnect an external browser.
   - Observe the late operation promise so it cannot create an unhandled rejection.
   - Release the queue only after teardown succeeds or reaches the existing bounded shutdown deadline.
5. If teardown fails or times out, latch `recoveryRequired` and reject later browser work with a retryable `BROWSER_RECOVERY_REQUIRED` error.
6. Make `browser_close_session` retry cleanup. Clear the latch only after teardown is confirmed.
7. Expose `recoveryRequired` in the browser runtime section returned by `server_health`.

An operation from an old lifecycle generation must never mutate or become current in a replacement generation, even if its promise settles late.

### Required tests

- Cooperative cancellation does not close other tabs or replace the browser.
- A promise that ignores abort causes exactly one teardown and cannot hold the queue forever.
- The next operation starts only after confirmed teardown.
- Failed teardown latches recovery and prevents overlapping generations.
- `browser_close_session` clears recovery only after successful cleanup.
- Shutdown still interrupts long waits and dialog-blocked actions within its existing deadline.

## 6. Phase 3 — Batch contract and result correctness

### Normalize once

- Add a batch normalization layer before canonical action validation.
- Continue accepting every current canonical internal action name.
- Also accept standalone-style action aliases, including:
  - `key` → `send_keys`
  - `select` → `select_dropdown`
  - `back`/`forward` → `go_back`/`go_forward`
  - `page_info` → `get_page_info`
  - `challenge` → `detect_challenge`
  - `interactive`/`frames` → `list_interactive`/`list_frames`
  - `downloads`, `upload`, and `pdf` → their existing canonical actions
- Normalize `tab_id` to `pageId`.
- Normalize cookie `name`, `value`, `domain`, `path`, `secure`, and `httpOnly` fields.
- Normalize storage `area`, `key`, `value`, and `all` fields.
- For grouped cookie, storage, dialog, network-log, and console-log concepts, accept `{action, operation}` and translate them to the canonical action.
- Reject simultaneous alias and canonical fields when both are present.
- Report the exact action index and conflicting field names in validation errors.

### Remove double validation

- Add a typed `BrowserService.executeBatch(actions, options, signal)` path.
- Pass the actions already validated by `browser_batch` directly to it.
- Parse `browser_exec` JSON once, then send it through the same normalizer and canonical validator.
- Keep runtime policy and capability checks inside the service; schema normalization must not bypass them.

### Preserve and bound results

- Preserve the successful public shape `{results: [...]}`.
- Do not apply the generic six-item search-result limit to batch results.
- Bound the array by the overall MCP byte budget, retaining as many ordered results as fit and returning `resultsTruncated` and `omittedResults` when necessary.
- On failure, keep `isError: true` and include bounded details containing `failedIndex`, `failedAction`, `completedActions`, and the completed result values that fit the error-detail budget.
- Add stable `details.hint` values only for errors with a concrete corrective action.

### Required tests

- Every canonical action validates through batch and `browser_exec`.
- Public aliases normalize to the same canonical values as standalone tools.
- Conflicting aliases fail before execution.
- A 50-action batch retains all small results.
- A large batch truncates only at the byte budget and reports exact omission metadata.
- Mid-batch failure preserves completed results and exact failure metadata.
- Destructive confirmation remains enforced after alias normalization.

## 7. Phase 4 — Composable observation and pagination

### Optional trailing snapshots

Add optional `includeSnapshot: boolean` to actions that leave a usable page:

- Navigate, click, input, select, scroll, key, back, forward, and reload.
- `browser_batch` at the top level.

Behavior:

- Default to `false` so existing payloads do not change.
- Capture the snapshot inside the same operation lock after a successful action.
- Return it under `snapshot`.
- For batch, capture one snapshot after the final successful action, never one per action.
- If the action succeeds but snapshot capture fails, return action success with `snapshot: null` and a bounded `snapshotError`. Do not turn the completed mutation into a retryable tool failure.
- A returned snapshot must contain current refs, revision, page ID, frame ID, and normal output bounds.

### Stable interactive reads

- Make `browser_interactive` project the current valid snapshot refs without generating a new snapshot ID.
- If no valid snapshot exists, it may capture one snapshot and return that projection.
- Repeated `browser_interactive` calls on an unchanged page must not invalidate previously returned refs.

### Pagination contracts

- Add `offset`, `nextOffset`, `hasMore`, and `revision` to `browser_extract`.
- Add optional `revision` input and the same output metadata to `browser_page_next`.
- Reject a supplied stale revision with retryable `STALE_PAGE_SLICE`.
- Advance `nextOffset` by the actual unwrapped slice length and never overlap adjacent slices.
- Add `totalMatches` and `matchesTruncated` to `browser_search_page`.
- Apply secret-placeholder redaction and untrusted wrapping to page slices and matches.
- Continue redacting evaluate output recursively. Wrap string evaluate results as untrusted; preserve structured values and add untrusted-source metadata without flattening them.
- Treat network and research URLs as untrusted data while preserving their sanitized structured URL fields.

### Required tests

- `includeSnapshot` returns actionable current refs.
- Snapshot failure after a mutation does not encourage the mutation to be retried.
- Batch returns one trailing snapshot.
- Repeated interactive reads preserve snapshot IDs and refs.
- Pagination has no gaps or overlap, detects stale revisions, and terminates correctly.
- Page slices, matches, evaluate strings, and URLs redact placeholders and remain bounded.

## 8. Phase 5 — Measured browser hot paths

Implement and benchmark these changes independently. Revert any change that fails the performance acceptance rule or weakens correctness.

### Page lookup

- Return a tracked live state immediately when its page ID/current page and lifecycle generation are valid.
- Call `browser.pages()` only for unknown IDs, stale states, tab enumeration, recovery, or selection of a fallback page.
- Preserve explicit page-closure and generation checks.

### Click targeting and navigation monitoring

- Validate a snapshot ref in one page evaluation that returns its signature, clickable descriptor, navigation URL, and one bounding rectangle.
- Read `getBoundingClientRect()` once per target.
- Resolve exact-text target, descriptor, URL, and rectangle in one evaluation.
- Arm main-frame navigation observation before dispatching the click.
- Replace the unconditional 150 ms sleep with a 50 ms navigation-start grace.
- Wait for bounded network idle only when navigation was observed.
- Return additive `navigated` and `urlChanged` booleans when known.

### Waits and extraction

- Replace element polling with a page-side observer or Puppeteer primitive that preserves attached/detached/visible/hidden semantics, including opacity and bounding-box checks.
- Replace URL polling with current-state checking plus frame-navigation events and a bounded timeout.
- Combine extracted text and links into one page evaluation.
- Combine exact-text search passes where the same DOM traversal is currently repeated.

### Snapshot and screenshot work

- After the main snapshot evaluation, collect title, optional frame metadata, and optional screenshot concurrently.
- Retain the final DOM revision and frame-detachment checks; discard inconsistent snapshots.
- Keep current screenshot quality and byte limits. Treat JPEG quality search and automatic PNG downscaling as separate experiments with visual-regression tests.

### Startup and discovery experiments

- Dynamically import Puppeteer on the first real launch/connect and cache the module promise.
- Measure bundling pure-JS dependencies while keeping Puppeteer external.
- Remove duplicated description boilerplate only when the global MCP instructions retain the same behavioral guidance.
- Preserve all tool names and compatibility alias descriptions.

### Prohibited shortcuts

- Do not memoize successful DNS or request-policy decisions.
- Do not add asynchronous log buffering that can lose shutdown diagnostics.
- Do not add container-only Chrome flags to all native launches.
- Do not remove untrusted boundaries merely to reduce tokens.
- Do not add a snapshot ring until a concrete multi-observer use case and memory bound are defined.

## 9. Phase 6 — Platform, testing, and delivery

### Platform fixes

- Regenerate `package-lock.json` so its root name and version match `smooth-operator-mcp@2.3.1` before changing the package version.
- Add a release check that package and lock metadata match.
- Use platform-aware path parsing and separators when detecting stale embedded interpreters.
- Accept valid absolute Windows browser paths in the wizard.
- Return status 500 for unexpected MCP resource failures while preserving safe messages and redacted diagnostics.
- Configure download behavior once per browser context, retaining the page-scoped fallback for older Chromium versions.

### Test architecture

- Add narrow typed dependencies for CDP sessions, timers, page enumeration, file staging, and HTTP serving where the new tests require them.
- Test new behavior through public `execute`, `snapshot`, runtime, and transport boundaries whenever practical.
- Keep useful private-method tests until equivalent public-boundary coverage exists; do not rewrite passing tests solely to remove casts.
- Raise browser-service coverage through security, recovery, batch, and live-browser scenarios rather than artificial line execution.

### CI layout

- Keep Linux lint, typecheck, unit, coverage, dead-code, build, and package-smoke checks.
- Move the Linux live-browser contract into a separate required job.
- Add a Windows job for installer, wizard, config, path handling, typecheck, and unit tests.
- Upload benchmark and live-browser diagnostic artifacts on success and failure.

### Documentation

- Document seven wizard steps consistently.
- Explain that `browserUrl` is derived when personal-Chrome mode is chosen; it is not a separate prompt.
- Document `includeSnapshot`, pagination revisions, batch aliases, recovery errors, and the worker request policy.
- Continue stating that DNS validation is best-effort preflight and not a firewall.
- Update version and tool-contract examples only after code and tests are final.

## 10. Release acceptance

Release 2.4.0 only when all conditions are satisfied:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:coverage`
5. `npm run dead-code`
6. `npm run build`
7. `npm run package:smoke:install`
8. Disabled source and bundled benchmarks complete with no status mismatches.
9. Linux live-browser security, action, batch, snapshot, and recovery tests pass.
10. Windows installer and path tests pass.
11. Public contract snapshots show no removals or incompatible field changes.
12. Every accepted hot-path change meets the median/p95 performance rule.
13. Package contents exclude `src/`, `tests/`, `coverage/`, `node_modules/`, `package-lock.json`, and development-only artifacts.
14. Documentation and package version metadata match the release.

After these gates pass, publishing automation may be added separately using a tag whose version matches `package.json`, npm trusted publishing, provenance, the complete verification suite, and package smoke installation.

## 11. Explicitly deferred work

The following items are outside 2.4.0 and require separate evidence and design:

- Network mocking.
- Form-fill helpers.
- Geolocation, device, locale, timezone, and media emulation.
- Drag-and-drop, clipboard, and permission management.
- Cookie-jar import/export.
- Download event orchestration.
- Snapshot diffs and multi-snapshot retention.
- Expanded PDF, select, IndexedDB, and screenshot APIs.
- Removing compatibility aliases or reducing the public tool count; this requires a planned 3.0 migration.
- Docker, MCPB, Smithery, and MCP registry packaging.
- DNS pinning or request rewriting without a TLS/SNI-safe implementation.
- Logger buffering, global container flags, or other unmeasured micro-optimizations.
- Hard CI timing gates until benchmark variance is proven stable.

These deferred items must not block the verified security, recovery, correctness, and round-trip work above.
