/**
 * Confirmation gate wiring + ask_human actual invocation tests.
 *
 * Verifies:
 *   - `shouldAskForConfirmation` delegates to `requiresConfirmation`
 *     (single source of truth).
 *   - `executeActionQueue` calls `requestConfirmation` for actions in the
 *     mode's `confirmRequired` list, blocks on decline, and proceeds on
 *     approval.
 *   - The `ask_human` executor action calls `askHuman()` and surfaces the
 *     real response (not a fabricated one).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldAskForConfirmation } from "../src/lib/agent/human-interaction";
import { requiresConfirmation, MODE_CONFIGS } from "../src/lib/agent/modes";
import type { AgentAction, LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

// The orchestrator's `executeActionQueue` runs `checkActionAllowed` BEFORE
// `requiresConfirmation` — but every action in standard mode's
// `confirmRequired` list (`evaluate`, `upload_file`, `save_as_pdf`) is itself
// mode-blocked in standard mode, so the confirmation path is unreachable via
// the real mode table. To exercise the wiring for real, mock `checkActionAllowed`
// to allow `evaluate` in standard mode while preserving every other modes
// export (`requiresConfirmation`, `MODE_CONFIGS`, etc.) for the tests below.
vi.mock("../src/lib/agent/modes", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/lib/agent/modes")>();
  return {
    ...original,
    checkActionAllowed: (actionType: string, mode: string) => {
      if (actionType === "evaluate" && mode === "standard") {
        return { allowed: true };
      }
      return original.checkActionAllowed(actionType, mode as never);
    },
  };
});

// ─── shouldAskForConfirmation delegates to requiresConfirmation ─────────────

describe("shouldAskForConfirmation is a single source of truth", () => {
  test("delegates to requiresConfirmation for every mode", () => {
    const actionTypes = ["click", "input", "evaluate", "upload_file", "save_as_pdf", "navigate", "close_tab", "switch_tab", "search"];
    for (const mode of ["restricted", "standard", "full_agentic"] as const) {
      for (const actionType of actionTypes) {
        expect(shouldAskForConfirmation(actionType, mode)).toBe(requiresConfirmation(actionType, mode));
      }
    }
  });

  test("standard mode requires confirmation for evaluate/upload_file/save_as_pdf", () => {
    expect(requiresConfirmation("evaluate", "standard")).toBe(true);
    expect(requiresConfirmation("upload_file", "standard")).toBe(true);
    expect(requiresConfirmation("save_as_pdf", "standard")).toBe(true);
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
// action (`evaluate` in `standard` mode — the mode mock above lets it
// through the mode check so the confirmation path is actually exercised).

describe("confirmation gate in executeActionQueue", () => {
  // F-15: `evaluate` fails closed without an explicit domain allowlist. The
  // "allows the action to proceed" test actually executes the evaluate, so the
  // jsdom origin (localhost) must be allowlisted; the decline test never
  // reaches execution but the config is harmless there.
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["localhost"],
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
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
    // `evaluate` no longer flags `pageChanged` (F-19), so the queue does NOT
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
    // Verify window.prompt was actually called.
    expect(window.prompt).toHaveBeenCalled();
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
