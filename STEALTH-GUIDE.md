# Stealth + CAPTCHA Solver — Opt-in Guide

## Overview & opt-in posture

SmoothOperator drives a real, headed Chromium-based browser that is
**identity-preserving by default** — it reports the normal automation signals so
the default build behaves like any other browser. Stealth is **opt-in and off by
default**; enabling it never changes the default, fails-closed behavior.

Turn the feature set on with environment variables (see `.env.example`):

- `SMOOTH_OPERATOR_STEALTH_ENABLED=true` — turns on the stealth baseline plus a JS
  fingerprint bundle.
- `SMOOTH_OPERATOR_BEHAVIOR_ENABLED` — behavioral realism; inherits
  `STEALTH_ENABLED` unless overridden to decouple it.
- `SMOOTH_OPERATOR_CAPTCHA_SOLVER_*` — the optional CAPTCHA solver provider, key,
  endpoint, proxy, and deadline.

All knobs are commented out and default OFF. The feature is fully implemented;
these variables select among its modes.

## The three layers

1. **Stealth baseline** — launches the browser with a real (non-headless)
   context, `--disable-blink-features=AutomationControlled`, and coherent
   `--lang` / `--window-size` so the browser profile does not contradict itself.
2. **JS fingerprint bundle** — a one-shot `evaluateOnNewDocument` patch set that
   hides `navigator.webdriver`, removes the `HeadlessChrome` token, and keeps the
   WebGL/canvas/UA stack internally coherent. Coherence-gated, so a partial patch
   that would expose contradictions stays off. Profiles: `balanced` (default) or
   `max` (fuller set); `SMOOTH_OPERATOR_STEALTH_GPU=true` forces real-GPU rendering
   for WebGL/canvas coherence.
3. **Behavioral realism** — human-like mouse movement, typing, and scrolling so
   interaction timing looks less mechanical.

## CAPTCHA workflow

When a site raises a challenge, the flow is:

1. **`browser_challenge`** — detects the challenge and returns **evidence-only**
   results (no solving). This is always available.
2. **`browser_wait_for_human`** — the default: pauses the Chrome window for a human
   to solve the challenge, then resumes.
3. **`browser_solve_challenge`** — opt-in: when a solver is configured via
   `SMOOTH_OPERATOR_CAPTCHA_SOLVER_*`, it attempts to solve the detected challenge
   through the solver service and falls back to human-in-the-loop otherwise.

Every attempt reports an honest `bypassAttempted` flag. The server performs no
CAPTCHA solving unless a solver is explicitly configured, and it reports
challenges rather than silently bypassing them.

## Responsible use & limits

- **Necessary but not sufficient.** Stealth reduces automation fingerprints; it
  does not guarantee passage of advanced anti-bots such as Cloudflare, DataDome,
  or Arkose. IP reputation and session warmth are co-factors outside the server's
  control.
- **Opt-in by default.** Nothing changes unless you set the flags above.
- **Operator responsibility.** You own compliance with target sites' Terms of
  Service and applicable laws. Use the feature only where permitted.
- **Proxy transparency.** A residential solver proxy is supported, but the intent
  is transparency — do not use it to hide a datacenter origin deceptively.
- **No CAPTCHA bypass by default.** Solving requires an explicit solver provider
  and API key; without a key the server falls back to human-in-the-loop.

## Verification targets

With `SMOOTH_OPERATOR_STEALTH_ENABLED=true`, expect the usual signals to flip to
"green" on these probes:

- **bot.sannysoft.com** — `navigator.webdriver` hidden; automation flags cleared.
- **tls.peet.ws** — coherent TLS/ClientHello fingerprint.
- **browserleaks.com** — a coherent UA, no `HeadlessChrome` token, consistent
  browser/OS signals.

Run one page with stealth **on** and one with it **off** and compare, so you can
see the default is unchanged and the opt-in change is what produced the difference.

---

For the technical detail behind these modes, see `STEALTH-CAPTCHA-PLAN.md`.
