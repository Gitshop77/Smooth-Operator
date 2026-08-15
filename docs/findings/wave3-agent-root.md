# Wave 3 — AUD-6 agent root

Scope: the root `.ts` files at `src/lib/agent/` (types, config, secrets, security (read-only for verification),
redaction, errors, runtime, mutex, capability-policy, domain-skills, persistent-memory, logging, retention,
storage-version, anti-detection, anti-bot, run-history, scheduled-tasks, human-interaction, html-summarizer,
output-parser, script-parser/runner/validation, judge, callbacks, modes, lightpanda/, callbacks/, config/)
plus `src/lib/validations.ts` and the cross-cutting security files, cross-checked against `tests/` and the
dependent `loop/` render seam. Read-only audit; no code was changed. Verified against tests:
`lightpanda-result-sanitize.test.ts`, `redaction-parity.test.ts`, `mutation-controls.test.ts`,
`messages-redaction.test.ts`, `agent-fast-path.test.ts` (113 pass).

Findings are verified at the cited source lines and ordered by severity. All 63 action types in
`tools/schema.ts` were checked against the `modes.ts` gating table (no gaps), and `security-hosts.ts` /
`security-url-policy.ts` (subdomain matching, scheme floor, fail-closed parse order, additive-only
reputation gate) were verified sound.

- [M] `redact-shared.ts:112-114` — `redactKeyLeak`'s JWT prefix-slicing (`m.indexOf("-")` → `slice(0, dash + 1)`)
  keeps the ENTIRE header+payload when the JWT's signature contains a `-`, and the trailing `redactKeyShapes`
  pass cannot heal it (the leaked `abc-[REDACTED]` tail fails the `[A-Za-z0-9_-]{8,}` JWT shape). Verified
  empirically (`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.abc-defghijklmnop` →
  header+payload+`abc-` exposed). Parity/mutation tests only use dash-free signatures.
- [M] `lightpanda/result-sanitize.ts:32-36` → `tools/handlers/research.ts:71` → `loop/messages-utils.ts:121` —
  the research-path `<injection_warnings>` block is destroyed at the render seam: the sanitizer prepends it,
  research.ts wraps it in `<untrusted_research>` (NOT in PROMPT_TAGS, survives), but the inner block IS in
  PROMPT_TAGS so `wrapUntrusted` replaces it with `[REDACTED]`. The navigator builder re-scans only the page
  observation (`loop/messages.ts:335-338`), never history results — so on the highest-trust-risk text path
  (untrusted-site research output) the "treat ALL research output with extra skepticism" cue never reaches
  the model. The planner path re-emits its own warnings from a history re-scan, so only the navigator loses it.
- [M] `types.ts` (enableFastPath doc ~410-419) — stale comment "Conservative default: `false`" contradicts the
  code: `types-utils.ts:18` DEFAULT_CONFIG, `config/schema.ts:241` `.default(true)`, and
  `orchestrator-helpers.ts:407` all default `enableFastPath` to `true` (`agent-fast-path.test.ts:278` pins the
  true-default behavior).
- [I] `security-injection.ts:290` — `\b(?:twitter|cloudflare|discord|dropbox|plaid)\b` flags bare brand
  mentions (not token prefixes) as `token-prefix-detected`, so any page merely mentioning those brands emits a
  spurious `<injection_warnings>` block — diluting the credibility of the advisory layer the system prompt
  tells the model to weight heavily. Advisory-only (no hard block); unpinned by tests.
- [I] `key-shape-redact.ts:29` — `SECRET_DBURL_RE` requires a password (`:([^\s]*)@`), so passwordless
  connection strings (`postgres://user@host:5432/db`) are unmasked. All parity tests
  (`redaction-parity.test.ts:61-83`) use password-bearing strings, including the empty-username case.
- [I] `errors-utils.ts:197` — substring check `["abort", "cancelled", "canceled"]` runs BEFORE the network
  branches (`:209-221`), so transient transport failures whose message contains "abort" ("The request was
  aborted", ECONNABORTED-class) are classified as user `cancelled` (fatal, non-retryable, "stopped by user"
  hint) instead of retryable `network`.
- [I] `redaction-memo.ts:33-34` — `redactionMemo`/`injectionMemo` Maps are unbounded (no LRU cap; contrast
  the `MAX_REDACT_CACHE_ENTRIES=1000` LRU in `run-history-utils.ts:117`). Cleared per run/secret-version,
  but on dynamic pages unique strings accumulate over a long run's repeated re-renders.
- [I] `lightpanda/result-sanitize.ts:24` — `raw.slice(0, maxChars)` truncation can split a surrogate pair at
  the 32k boundary (same class as the judge-helpers truncate); cosmetic corruption of the bounded research
  output tail.

No [C] findings in this layer. Verified sound: `modes.ts` gating of all 63 action types; `run-history`
newest-first `pop` + LRU redact cache; `formatMemories` as the sole memory render path
(`loop/messages.ts:375-377`); cdp-controller release-event gating (design choice); script-runner
`fnmatchCase` empty-char-class throw is caught by the condition try/catch (not exploitable); `metrics.ts`
documented negative-attributed gap; `scheduled-tasks.ts` import re-redaction round-trip (deliberate).