# Browser identity, compatibility, and challenge handling

## Defaults

SmoothOperator drives a real Chromium-based browser. The recommended native
profile is headed, persistent, keeps Chromium's native identity and automation
signals, and enables page evaluation. All local browser tools are available
from the first request. Behavioral timing is off by default for fast,
deterministic input.

The installer asks exactly three questions: browser profile ownership, browser
display, and the Chromium executable. Managed mode owns one private persistent
profile below `SMOOTH_OPERATOR_DATA_DIR`; connected mode launches and attaches
to a dedicated debugging profile and does not claim ownership of an operator's
daily browser. A profile is not a privacy boundary from the websites it visits,
so use a dedicated profile and the narrowest policy that fits the task.

## Optional controls

`SMOOTH_OPERATOR_STEALTH_ENABLED=true` is retained as a compatibility setting.
It applies only an explicitly configured viewport and never hides automation
signals or fabricates a user agent, platform, browser version, language, client
hints, WebGL, canvas, TLS, or operating-system identity. Set it to `false` to
skip that viewport script entirely.

`SMOOTH_OPERATOR_STEALTH_PROFILE=balanced` or `max` are accepted compatibility
labels for the same supported patch set. `SMOOTH_OPERATOR_STEALTH_GPU=true`
adds GPU launch flags but is not an identity or coherence guarantee.

`SMOOTH_OPERATOR_BEHAVIOR_ENABLED` controls optional pointer, typing, and
scrolling timing wrappers. It defaults off for the fastest raw interaction
path. If enabled, timings are short, bounded, and cancellable; this is a
workflow choice, not a guarantee of human identity or site access.

## Connected-AI challenge loop

`browser_challenge` is an evidence-only detector and is available by default.
`browser_solve_challenge` is an internal connected-AI loop: each call is one
bounded verification cycle. It collects a fresh challenge classification and
bounded visual/state evidence, including `attemptsRemaining`; the connected AI
uses normal browser actions and calls it again until the final classification
explicitly reports the challenge absent or `automation_exhausted`. The tool
returns screenshot data as MCP image content when requested. `present`,
`unknown`, or a failed probe is never success, and human handoff is only an
explicit option after exhaustion.

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

The server does not attempt to conceal automation or guarantee passage of a
challenge. Use automation only where the target and applicable law permit it.
