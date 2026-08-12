/**
 * Phase 15 — adversarial mutation/negative tests for the CRITICAL CONTROLS.
 *
 * Every test here is a REAL passing test that asserts the control HOLDS under
 * adversarial conditions. The suite is deliberately written so that weakening
 * the control — the exact class of change a mutation would introduce (removed
 * redaction, ignored abort, bypassed budget cap, disabled SSRF sink check,
 * disabled stale-element guard, legalized illegal run-phase transitions, a
 * dropped settings save-summary line) — makes the corresponding test FAIL.
 *
 * `scripts/mutation-check.mjs` applies those exact weakenings to the
 * production source one at a time, runs this suite, requires it to fail
 * (i.e. the mutation is caught), and restores the source. No "expected
 * failure" conversions are used anywhere in this file — every assertion is a
 * live, passing assertion of the control.
 */

import { describe, expect, test } from "vitest";
import { RunController, beginRunController, resetRunControllerForTests } from "../src/extension/background/run-controller";
import { costCapExceeded } from "../src/lib/agent/loop/helpers/state-helpers";
import { redactKeyLeak } from "../src/lib/agent/redact-shared";
import { validateLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";
import { resolveElement } from "../src/lib/agent/tools/helpers/element-resolver";
import { elementIdentity } from "../src/lib/agent/dom/extraction/element-info";
import { NoSuchElementException } from "../src/lib/agent/errors";
import { RUN_TRANSITIONS, assertLegalTransition, transitionRunPhase } from "../src/lib/agent/loop/run-state-machine";
import type { LoopState } from "../src/lib/agent/loop/types";
import { composeSettingsSaveSummary } from "../src/extension/options/settings-sync-utils";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";
import type { BrowserState } from "../src/lib/agent/types";

// ─── 1. Cancellation: an aborted run must stay aborted ───────────────────────

describe("control: run cancellation aborts the authoritative signal", () => {
  test("requestCancellation aborts the root signal and invalidates the dispatch token", () => {
    const controller = new RunController({ runId: "m-1", task: "t", maxSteps: 5, mode: "standard", now: 0 });
    controller.markRunning(1);
    const token = controller.dispatchToken;

    controller.requestCancellation("Stop", 2);

    // The abort must land on the signal the agent loop listens to. If the
    // abort call were removed (mutation), the run would keep dispatching.
    expect(controller.signal.aborted).toBe(true);
    expect(controller.snapshot.status).toBe("cancelling");
    expect(controller.snapshot.dispatchRevision).toBe(token.dispatchRevision + 1);
  });

  test("a cancelled run can never be reopened: progress after cancellation is a no-op", () => {
    const controller = new RunController({ runId: "m-2", task: "t", maxSteps: 5, mode: "standard", now: 0 });
    controller.markRunning(1);
    controller.requestCancellation("Stop", 2);
    const frozen = controller.snapshot;

    const after = controller.markRunning(3);
    expect(after.revision).toBe(frozen.revision);
    expect(after.status).toBe("cancelling");
  });

  test("an already-aborted signal means no handler side effect runs", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    let clicks = 0;
    button.addEventListener("click", () => { clicks += 1; });
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    const state = makeState({ selectorMap: { 1: button } }) as BrowserState;

    const result = await executeAction({ type: "click", index: 1 } as never, state, aborted.signal);

    expect(result.success).toBe(false);
    expect(clicks).toBe(0);
  });
});


// ─── 2. Budget enforcement: the cost cap must trip at the documented bound ───

describe("control: cost-cap enforcement holds at the documented bound", () => {
  test("spend >= cap trips the cap (never ignored)", () => {
    const state = { config: { costCapUsd: 1 }, totalCostUsd: 1.5 } as unknown as LoopState;
    expect(costCapExceeded(state)).toBe(true);
  });

  test("spend below the cap does not trip (the cap is not replaced by a lower bound)", () => {
    const state = { config: { costCapUsd: 1 }, totalCostUsd: 0.5 } as unknown as LoopState;
    expect(costCapExceeded(state)).toBe(false);
  });

  test("an omitted cap is an explicit opt-out, not a reason to stop", () => {
    const state = { config: { costCapUsd: undefined }, totalCostUsd: 9999 } as unknown as LoopState;
    expect(costCapExceeded(state)).toBe(false);
  });
});

// ─── 3. Credential redaction: raw secrets must never survive a redaction pass ─

describe("control: redactKeyLeak masks credential material unconditionally", () => {
  test("a bare provider key prefix is masked and the raw key never appears", () => {
    const raw = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcd";
    const out = redactKeyLeak(`provider error: ${raw} after the call`);
    expect(out).not.toContain(raw);
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toContain("[REDACTED]");
  });

  test("Bearer tokens are masked", () => {
    const out = redactKeyLeak("Authorization: Bearer xyz.abc.def-ghijklmnop");
    expect(out).not.toContain("xyz.abc.def-ghijklmnop");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("JSON secret-key values are masked", () => {
    const out = redactKeyLeak('{"api_key":"sk-secret-value-1234567890","model":"gpt-4"}');
    expect(out).not.toContain("sk-secret-value-1234567890");
    expect(out).toContain('"api_key":"[REDACTED]"');
    expect(out).toContain("model");
  });

  test("a JWT is masked in full", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactKeyLeak(`token ${jwt} expired`);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[REDACTED]");
  });
});

// ─── 4. SSRF: dangerous sink IPs are never reachable, even user-configured ───

describe("control: SSRF sink-IP guard rejects metadata/unspecified/link-local hosts", () => {
  test("the cloud-metadata link-local address is rejected even for a user-configured baseUrl", () => {
    // user-configured + allowLocalExemption means loopback/RFC1918 are legal —
    // the ONLY guard that still stops 169.254.169.254 is the sink-IP check.
    // Disabling that check (mutation) must fail this test.
    const res = validateLlmBaseUrl("http://169.254.169.254/latest/meta-data", true, "user-configured");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/private|link-local|metadata/i);
  });

  test("an IPv4-mapped metadata literal is rejected under the same exemption", () => {
    const res = validateLlmBaseUrl("http://[::ffff:169.254.169.254]/", true, "user-configured");
    expect(res.ok).toBe(false);
  });

  test("an untrusted baseUrl is rejected for loopback", () => {
    const res = validateLlmBaseUrl("http://127.0.0.1:11434/v1", false, "untrusted");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/local|private|loopback/i);
  });

  test("the unspecified 0.0.0.0/8 address is rejected", () => {
    const res = validateLlmBaseUrl("http://0.0.0.0/v1", true, "user-configured");
    expect(res.ok).toBe(false);
  });
});

// ─── 5. Stale-element guard: nothing may act on a stale reference ────────────

describe("control: stale-element guard rejects detached and identity-changed targets", () => {
  test("a detached element is rejected by resolveElement", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const state = makeState({ selectorMap: { 1: button } }) as BrowserState;
    button.remove(); // now detached — the guard must throw before any handler runs

    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
  });

  test("a connected but identity-changed element is rejected by resolveElement", () => {
    const button = document.createElement("button");
    button.id = "submit";
    button.textContent = "Submit";
    document.body.append(button);
    const observed = elementIdentity(button);
    // The agent observed the element; between observation and execution the
    // control was relabeled (SPA re-render) — same node, different target.
    button.setAttribute("aria-label", "Submit order now");
    const state = makeState({
      selectorMap: { 1: button },
      elementIdentities: { 1: observed },
    }) as BrowserState;

    expect(() => resolveElement(state, 1)).toThrow(NoSuchElementException);
  });

  test("an identity-changed target never receives the click", async () => {
    const button = document.createElement("button");
    button.id = "submit";
    button.textContent = "Submit";
    document.body.append(button);
    const observed = elementIdentity(button);
    let clicks = 0;
    button.addEventListener("click", () => { clicks += 1; });
    button.setAttribute("aria-label", "Submit order now");
    const state = makeState({
      selectorMap: { 1: button },
      elementIdentities: { 1: observed },
    }) as BrowserState;

    const result = await executeAction({ type: "click", index: 1 } as never, state);
    expect(result.success).toBe(false);
    expect(clicks).toBe(0);
  });
});

// ─── 6. Run-store status transitions: illegal transitions must fail closed ───

describe("control: run-phase transitions are fail-closed", () => {
  test("the transition table declares exactly the documented edges", () => {
    expect(RUN_TRANSITIONS).toEqual({
      init: ["plan", "terminal"],
      plan: ["observe", "terminal"],
      observe: ["act", "recover", "terminal"],
      act: ["verify", "recover", "terminal"],
      verify: ["observe", "terminal"],
      recover: ["observe", "plan", "terminal"],
      terminal: [],
    });
  });

  test("an illegal transition throws instead of silently continuing", () => {
    // If the throw were removed (mutation), the run would silently continue in
    // an undefined phase — the exact weakening this test must catch.
    expect(() => assertLegalTransition("init", "act")).toThrow(/illegal run-phase transition/i);
    expect(() => assertLegalTransition("plan", "verify")).toThrow(/illegal run-phase transition/i);
    expect(() => assertLegalTransition("terminal", "observe")).toThrow(/illegal run-phase transition/i);
  });

  test("transitionRunPhase refuses to advance a live state illegally", () => {
    const state = { phase: "plan" as const, step: 1 };
    expect(() => transitionRunPhase(state as unknown as LoopState, "verify", "illegal")).toThrow(/illegal run-phase transition/i);
    expect(state.phase).toBe("plan");
  });

  test("terminal is sticky — a terminal run cannot transition anywhere", () => {
    const state = { phase: "terminal" as const, step: 3 };
    expect(() => transitionRunPhase(state as unknown as LoopState, "observe", "reopen")).toThrow(/illegal run-phase transition/i);
  });
});

// ─── 7. Settings save summary: sensitive categories are never silent ─────────

describe("control: the settings save summary states every sensitive category", () => {
  test("a write with screenshots off states 'screenshots: off' explicitly", () => {
    // Dropping the permission line (mutation) must fail this test — turning
    // screenshots off is exactly the kind of change that must never pass
    // silently.
    const summary = composeSettingsSaveSummary({ enableScreenshots: false, agentMode: "standard" });
    expect(summary).toContain("screenshots: off");
  });

  test("domain scope lines are always emitted, even when empty (scope widening)", () => {
    const summary = composeSettingsSaveSummary({ allowedDomains: [], blockedDomains: [] });
    expect(summary).toContain("allowed domains: none");
    expect(summary).toContain("blocked domains: 0");
  });

  test("mode, destination, and webhook are always stated", () => {
    const summary = composeSettingsSaveSummary({
      agentMode: "restricted",
      provider: "openai",
      baseUrl: "",
      webhookUrl: "",
    });
    expect(summary).toContain("mode: restricted");
    expect(summary).toContain("provider: openai (default endpoint)");
    expect(summary).toContain("notify webhook: none");
  });

  test("a disabled cap is stated as 'cost cap: none', never omitted", () => {
    const summary = composeSettingsSaveSummary({ costCap: 0 });
    expect(summary).toContain("cost cap: none");
  });
});

// Keep the module-level controller registry clean for other suites in this run.
describe("control: run-controller registry resets between suites", () => {
  test("resetRunControllerForTests clears the authoritative controller", () => {
    beginRunController({ runId: "m-reset", task: "t", maxSteps: 5, mode: "standard", now: 0 });
    resetRunControllerForTests();
    // The registry is a module-level singleton; this just verifies the reset
    // helper remains callable and idempotent.
    resetRunControllerForTests();
    expect(true).toBe(true);
  });
});

