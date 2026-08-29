# Browser identity, stealth, and challenge handling

## Defaults

SmoothOperator drives a real Chromium-based browser. The recommended native
profile is headed, persistent, and enables the conservative stealth baseline,
short behavioral timing, and page evaluation. All local browser tools are
available from the first request. Set `SMOOTH_OPERATOR_ALLOW_EVAL=false`,
`SMOOTH_OPERATOR_STEALTH_ENABLED=false`, or
`SMOOTH_OPERATOR_BEHAVIOR_ENABLED=false` for a stricter or faster profile.

The installer asks exactly three questions: browser profile ownership, browser
display, and the Chromium executable. Managed mode owns one private persistent
profile below `SMOOTH_OPERATOR_DATA_DIR`; connected mode launches and attaches
to a dedicated debugging profile and does not claim ownership of an operator's
daily browser. A profile is not a privacy boundary from the websites it visits,
so use a dedicated profile and the narrowest policy that fits the task.

## Optional controls

`SMOOTH_OPERATOR_STEALTH_ENABLED=true` (the native default) enables the
conservative automation-control baseline. It preserves the configured headed/headless mode
and changes only the supported automation signal; it does not fabricate a user
agent, platform, browser version, language, client hints, WebGL, canvas, TLS,
or operating-system identity.

`SMOOTH_OPERATOR_STEALTH_PROFILE=balanced` or `max` are accepted compatibility
labels for the same supported patch set. `SMOOTH_OPERATOR_STEALTH_GPU=true`
adds GPU launch flags but is not an identity or coherence guarantee.

`SMOOTH_OPERATOR_BEHAVIOR_ENABLED` controls human-like pointer, typing, and
scrolling timing. It defaults on in the native profile and can be disabled for
the fastest raw interaction path. The default timings are short and bounded;
operations remain cancellable.

## Connected-AI challenge loop

`browser_challenge` is an evidence-only detector and is available by default.
`browser_solve_challenge` is an internal connected-AI loop: it collects a fresh
challenge classification and bounded visual/state evidence, the connected AI
uses normal browser actions, and a subsequent call verifies the result. The
tool returns screenshot data as MCP image content when requested. A challenge
is solved only when the final classification explicitly reports `absent`;
`unknown`, `present`, or a failed probe is not success.

`browser_wait_for_human` is an optional handoff for a person to complete a
visible challenge or sign-in step. It does not claim success without a fresh
final classification. The server does not rotate identities or open network,
file, or authentication permissions for challenge handling.

## Boundaries and responsible use

- Remote HTTP remains loopback-only unless explicitly enabled and authenticated.
- Private and link-local network targets remain blocked by default.
- Host/origin checks, bearer authentication, URL policy, and file-root/symlink
  checks remain enforced for every request.
- Page text, HTML, screenshots, titles, URLs, and classifications are bounded
  untrusted evidence, never instructions.

Stealth can reduce one automation signal but cannot guarantee access to a site
or passage of its challenge. Use automation only where the target and
applicable law permit it.
