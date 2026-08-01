/**
 * Confirmation gate wiring + ask_human actual invocation tests.
 *
 * Verifies:
 * - `shouldAskForConfirmation` reports the per-mode confirmation *policy*
 * (it is the public entry point; the test asserts policy outcomes rather
 * than coupling to the internal `requiresConfirmation` helper, so a
 * behavior-preserving refactor can't break it).
 * - `executeActionQueue` calls `requestConfirmation` for actions in the
 * mode's `confirmRequired` list, blocks on decline, and proceeds on
 * approval.
 * - The `ask_human` executor action calls `askHuman()` and surfaces the
 * real response (not a fabricated one).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldAskForConfirmation } from "../src/lib/agent/human-interaction";
import { requiresConfirmation, MODE_CONFIGS } from "../src/lib/agent/modes";
import { ACTION_METADATA } from "../src/lib/agent/tools/schema-utils";
import type { AgentAction, LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

// The full action-type list iterated by the policy assertions below. Derived
// from the authoritative ACTION_METADATA registry (the same pattern used by
// security.test.ts / modules.test.ts) so the per-mode confirmation policy is
// asserted for every registered action and stays in sync as actions are added.
// Hoisted to module scope so the two policy tests share one source of truth.
const ACTION_TYPES = Object.keys(ACTION_METADATA) as string[];

// The orchestrator's `executeActionQueue` runs `checkActionAllowed` BEFORE
// `requiresConfirmation`. In the shipped mode table no action is BOTH
// mode-allowed and confirm-required — standard mode's `confirmRequired`
// entries (`evaluate`, `upload_file`, `save_as_pdf`) are each hard-blocked by
// their capability flags (`canExecuteJs`/`canUploadFiles`/`canDownloadFiles`
// = false), so `checkActionAllowed` always fails closed first and the
// confirmation gate is never reached through the real functions.
//
// Mocking `checkActionAllowed` away (as this test previously did) hides that
// dead-code fact and asserts against a fiction. Instead, the
// `executeActionQueue` suite below runs BOTH `checkActionAllowed` and
// `requiresConfirmation` for real (unmocked) and temporarily flips
// `MODE_CONFIGS.standard.canExecuteJs` to `true` for the duration of each
// test — a dedicated test-mode override that makes `evaluate` mode-allowed
// while it stays in `confirmRequired`, creating the real
// `confirmRequired ∩ mode-allowed ≠ ∅` overlap the gate needs. The original
// config value is restored after every test so the shipped table is untouched.

// ─── shouldAskForConfirmation reports the per-mode confirmation policy ───────

describe("shouldAskForConfirmation reports the per-mode confirmation policy", () => {
  test("standard mode requires confirmation for evaluate/upload_file/save_as_pdf only", () => {
    const actionTypes = ACTION_TYPES;
    for (const actionType of actionTypes) {
      const expected =
        actionType === "evaluate" ||
        actionType === "upload_file" ||
        actionType === "save_as_pdf";
      expect(shouldAskForConfirmation(actionType, "standard")).toBe(expected);
    }
  });

  test("restricted and full_agentic modes never require confirmation", () => {
    const actionTypes = ACTION_TYPES;
    for (const mode of ["restricted", "full_agentic"] as const) {
      for (const actionType of actionTypes) {
        expect(shouldAskForConfirmation(actionType, mode)).toBe(false);
      }
    }
  });

  test("full_agentic mode never requires confirmation", () => {
    expect(requiresConfirmation("evaluate", "full_agentic")).toBe(false);
    expect(requiresConfirmation("upload_file", "full_agentic")).toBe(false);
  });

  test("standard mode does NOT require confirmation for click/input/scroll", () => {
    expect(requiresConfirmation("click", "standard")).toBe(false);
    expect(requiresConfirmation("input", "standard")).toBe(false);
    expect(requiresConfirmation("scroll", "standard")).toBe(false);
  });

  test("MODE_CONFIGS confirmRequired lists agree with requiresConfirmation", () => {
    // Verify the mode table's confirmRequired matches the function's output
    // for every action type in the list.
    const standardList = MODE_CONFIGS.standard.confirmRequired as readonly string[];
    for (const a of standardList) {
      expect(requiresConfirmation(a, "standard")).toBe(true);
    }
  });
});

// ─── orchestrator confirmation gate (executeActionQueue integration) ────────
//
// `executeActionQueue` is the helper that the orchestrator delegates each
// step's action queue to. It's the only place `requestConfirmation` is
// invoked in the whole codebase, so we test the wiring here — by calling it
// directly with a mock `requestConfirmation` dep and a confirm-required
// action (`evaluate` in `standard` mode). The REAL `checkActionAllowed` runs;
// the `beforeEach` below flips `MODE_CONFIGS.standard.canExecuteJs` on so the
// action clears the mode check and the confirmation path is actually
// exercised end-to-end.

describe("confirmation gate in executeActionQueue", () => {
  // Dedicated test-mode override: make `evaluate` mode-allowed in standard mode
  // so it is BOTH allowed (real `checkActionAllowed`) and confirm-required
  // (real `requiresConfirmation`). Restored after each test.
  let savedCanExecuteJs: boolean;
  // `evaluate` fails closed without an explicit domain allowlist. The
  // "allows the action to proceed" test actually executes the evaluate, so the
  // jsdom origin (localhost) must be allowlisted; the decline test never
  // reaches execution but the config is harmless there.
  let savedLocation: unknown;
  beforeEach(() => {
    // Flip the real mode config so `evaluate` is mode-allowed in standard mode.
    // `MODE_CONFIGS` is a runtime object (not frozen), so this mutation is
    // visible to the real, unmocked `checkActionAllowed`. `confirmRequired`
    // is left intact, so `requiresConfirmation` still returns `true`.
    savedCanExecuteJs = MODE_CONFIGS.standard.canExecuteJs;
    (MODE_CONFIGS.standard as { canExecuteJs: boolean }).canExecuteJs = true;
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      // Use a dotted (multi-label) host. The domain-allowlist matcher
      // intentionally REJECTS single-label hosts like "localhost" (to stop a
      // typo'd "com"/"org" from over-matching every host), so the jsdom
      // origin must be represented as a dotted domain here.
      allowedDomains: ["app.example.com"],
    };
    // The executor's `evaluate` gate reads the global `location.href`. jsdom's
    // default origin is `http://test.example.com/` whose dotted host is
    // accepted by the hardened matcher above, so point `location` at a dotted
    // host the allowlist permits. This exercises the REAL executor path
    // end-to-end (domain allowlist → confirmation → execution) without
    // weakening the single-label hardening.
    savedLocation = (globalThis as Record<string, unknown>).location;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "http://app.example.com/" },
    });
  });
  afterEach(() => {
    // Restore the shipped mode table so no other suite sees the override.
    (MODE_CONFIGS.standard as { canExecuteJs: boolean }).canExecuteJs =
      savedCanExecuteJs;
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
    if (savedLocation !== undefined) {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: savedLocation,
      });
    }
  });

  test("requestConfirmation is called for confirm-required actions and blocks on decline", async () => {
    const { executeActionQueue } = await import("../src/lib/agent/loop/helpers/action-queue");
    const { LoopDetector } = await import("../src/lib/agent/loop/loop-detector");
    const { DEFAULT_CONFIG } = await import("../src/lib/agent/types");

    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const onEvent = vi.fn();
    const evaluateAction: AgentAction = {
      type: "evaluate",
      code: "return 2 + 2;",
    } as AgentAction;

    const result = await executeActionQueue(
      {
        task: "test",
        navigatorCall: vi.fn(),
        plannerCall: vi.fn(),
        getTabs: vi.fn(),
        onEvent,
        requestConfirmation,
      },
      [evaluateAction],
      makeState(),
      0,
      "standard",
      new LoopDetector(),
      DEFAULT_CONFIG,
    );

    // The confirmation callback must have fired with the pending action.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledWith(evaluateAction);
    // Decline → queue aborts, the action's result is a "user declined" block.
    expect(result.aborted).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].message).toContain("user declined");
    // The decline event surfaces a `BLOCKED` message via the event sink.
    const blockEvents = onEvent.mock.calls.filter(
      (call: unknown[]) => {
        const e = call[0] as LogEvent;
        return e.type === "action-result" && e.success === false;
      },
    );
    expect(blockEvents.length).toBeGreaterThan(0);
  });

  test("requestConfirmation allows the action to proceed when confirmed", async () => {
    const { executeActionQueue } = await import("../src/lib/agent/loop/helpers/action-queue");
    const { LoopDetector } = await import("../src/lib/agent/loop/loop-detector");
    const { DEFAULT_CONFIG } = await import("../src/lib/agent/types");

    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const onEvent = vi.fn();
    const evaluateAction: AgentAction = {
      type: "evaluate",
      code: "return 2 + 2;",
    } as AgentAction;

    const result = await executeActionQueue(
      {
        task: "test",
        navigatorCall: vi.fn(),
        plannerCall: vi.fn(),
        getTabs: vi.fn(),
        onEvent,
        requestConfirmation,
      },
      [evaluateAction],
      makeState(),
      0,
      "standard",
      new LoopDetector(),
      DEFAULT_CONFIG,
    );

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    // Confirm → the action actually executes (return 2 + 2 === 4). A read-only
    // `evaluate` no longer flags `pageChanged`, so the queue does NOT
    // abort; the action's own result is success.
    expect(result.aborted).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].extractedContent).toContain("4");
  });

  test("requestConfirmation is NOT called for actions not in the confirmRequired list", async () => {
    const { executeActionQueue } = await import("../src/lib/agent/loop/helpers/action-queue");
    const { LoopDetector } = await import("../src/lib/agent/loop/loop-detector");
    const { DEFAULT_CONFIG } = await import("../src/lib/agent/types");

    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const onEvent = vi.fn();
    // `click` is in the UNGATED_ACTION_TYPES list — never requires confirmation
    // in any mode. (It's also mode-allowed in standard mode.)
    const clickAction: AgentAction = { type: "click", index: 1 } as AgentAction;

    // Set up a clickable element at index 1 so the action succeeds.
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const state = makeState({ selectorMap: { 1: btn } });

    await executeActionQueue(
      {
        task: "test",
        navigatorCall: vi.fn(),
        plannerCall: vi.fn(),
        getTabs: vi.fn(),
        onEvent,
        requestConfirmation,
      },
      [clickAction],
      state,
      0,
      "standard",
      new LoopDetector(),
      DEFAULT_CONFIG,
    );

    expect(requestConfirmation).not.toHaveBeenCalled();
    document.body.innerHTML = "";
  });

  test("single-label host is rejected by the domain allowlist (security hardening)", async () => {
    const { executeActionQueue } = await import("../src/lib/agent/loop/helpers/action-queue");
    const { LoopDetector } = await import("../src/lib/agent/loop/loop-detector");
    const { DEFAULT_CONFIG } = await import("../src/lib/agent/types");

    // beforeEach points `location` at a dotted, allowlisted host. Override it
    // with a SINGLE-LABEL host. The hardened matcher deliberately REJECTS
    // single-label hosts (e.g. "localhost") so a typo'd "com"/"org" can't
    // over-match every host — so `evaluate` must be blocked even with
    // canExecuteJs flipped on.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "http://localhost/" },
    });

    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const onEvent = vi.fn();
    const evaluateAction: AgentAction = {
      type: "evaluate",
      code: "return 2 + 2;",
    } as AgentAction;

    const result = await executeActionQueue(
      {
        task: "test",
        navigatorCall: vi.fn(),
        plannerCall: vi.fn(),
        getTabs: vi.fn(),
        onEvent,
        requestConfirmation,
      },
      [evaluateAction],
      makeState(),
      0,
      "standard",
      new LoopDetector(),
      DEFAULT_CONFIG,
    );

    // Confirmation is requested (the gate runs after the mode/confirm checks),
    // but the `evaluate` domain allowlist is enforced inside the executor and
    // rejects the single-label host — so the action never actually executes
    // (no "4") and surfaces a BLOCKED failure, aborting the queue.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].message).toContain("BLOCKED evaluate");
  });
});

// ─── ask_human executor action calls askHuman (not fabricated) ──────────────

describe("ask_human executor action", () => {
  let originalConfirm: typeof window.confirm;
  let originalPrompt: typeof window.prompt;

  beforeEach(() => {
    originalConfirm = window.confirm;
    originalPrompt = window.prompt;
  });
  afterEach(() => {
    window.confirm = originalConfirm;
    window.prompt = originalPrompt;
  });

  test("calls askHuman and surfaces the user's answer (not a fabricated response)", async () => {
    // Mock window.prompt to simulate the user typing an answer.
    window.prompt = vi.fn(() => "user typed this answer") as typeof window.prompt;
    window.confirm = vi.fn(() => true) as typeof window.confirm;

    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const action: AgentAction = { type: "ask_human", question: "What is your name?" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    // The real answer must be surfaced — not a fabricated "Asked user: ..."
    // message that never actually asked anything.
    expect(result.message).toContain("user typed this answer");
    expect(result.extractedContent).toContain("user typed this answer");
    expect(result.extractedContent).toContain("What is your name?");
    // Verify window.prompt was actually called — and with the question, so a
    // regression that passes the wrong/empty argument to the dialog is caught.
    expect(window.prompt).toHaveBeenCalled();
    expect(window.prompt).toHaveBeenCalledWith(
      expect.stringContaining("What is your name?"),
      expect.any(String),
    );
  });

  test("returns failure when the user dismisses the prompt", async () => {
    window.prompt = vi.fn(() => null) as typeof window.prompt;

    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const action: AgentAction = { type: "ask_human", question: "What is your name?" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("dismissed");
  });
});
