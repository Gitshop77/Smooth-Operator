/**
 * ask_human per-run budget coverage.
 *
 * `handleAskHuman` opens a side-panel modal and blocks the loop for up to the
 * interaction timeout on every call, so a prompt-injected page can coax the
 * model into interruption spam. The per-run budget (keyed on the
 * authoritative dispatch runId) fails CLOSED once spent: no modal is opened
 * and the action reports an explicit budget-exhausted failure. A fresh run
 * receives a fresh budget; tokenless contexts share an anonymous bucket.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../../src/lib/agent/tools/handlers/types";
import {
  handleAskHuman,
  MAX_ASK_HUMAN_PER_RUN,
  consumeAskHumanBudget,
  resetAskHumanBudgetForTests,
} from "../../src/lib/agent/tools/handlers/ask-human";

const mocks = vi.hoisted(() => ({
  askHuman: vi.fn(async () => ({ mode: "input", value: "user answer" }) as const),
}));

vi.mock("../../src/lib/agent/human-interaction", () => ({
  askHuman: mocks.askHuman,
}));

function ctx(runId: string | undefined): ActionContext {
  return {
    state: { url: "http://example.com", title: "t", elements: [] } as never,
    beforeUrl: "http://example.com",
    beforeFingerprint: "",
    dispatchToken: runId ? { runId, dispatchRevision: 1 } : undefined,
  };
}

const action = { type: "ask_human", question: "Continue?", mode: "input" } as const;

beforeEach(() => {
  resetAskHumanBudgetForTests();
  mocks.askHuman.mockClear();
  mocks.askHuman.mockResolvedValue({ mode: "input", value: "user answer" });
});

afterEach(() => {
  resetAskHumanBudgetForTests();
});

describe("ask_human per-run budget", () => {
  test("the first MAX_ASK_HUMAN_PER_RUN asks are allowed and open the modal", async () => {
    for (let i = 0; i < MAX_ASK_HUMAN_PER_RUN; i++) {
      const result = await handleAskHuman(ctx("run-budget-a"), action);
      expect(result.success, `ask ${i + 1} must succeed`).toBe(true);
    }
    expect(mocks.askHuman).toHaveBeenCalledTimes(MAX_ASK_HUMAN_PER_RUN);
  });

  test("the ask after the budget is spent fails CLOSED without opening a modal", async () => {
    for (let i = 0; i < MAX_ASK_HUMAN_PER_RUN; i++) {
      await handleAskHuman(ctx("run-budget-a"), action);
    }
    const exhausted = await handleAskHuman(ctx("run-budget-a"), action);
    expect(exhausted.success).toBe(false);
    expect(exhausted.message).toMatch(/ask_human budget exhausted/i);
    // No modal was opened and no interaction was attempted.
    expect(mocks.askHuman).toHaveBeenCalledTimes(MAX_ASK_HUMAN_PER_RUN);
  });

  test("a NEW run receives a fresh budget", async () => {
    for (let i = 0; i < MAX_ASK_HUMAN_PER_RUN; i++) {
      await handleAskHuman(ctx("run-budget-a"), action);
    }
    expect((await handleAskHuman(ctx("run-budget-a"), action)).success).toBe(false);
    expect((await handleAskHuman(ctx("run-budget-b"), action)).success).toBe(true);
    expect(mocks.askHuman).toHaveBeenCalledTimes(MAX_ASK_HUMAN_PER_RUN + 1);
  });

  test("tokenless contexts share an anonymous bucket (no unbounded modal spam)", async () => {
    for (let i = 0; i < MAX_ASK_HUMAN_PER_RUN; i++) {
      expect((await handleAskHuman(ctx(undefined), action)).success).toBe(true);
    }
    const result = await handleAskHuman(ctx(undefined), action);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/budget exhausted/i);
  });

  test("consumeAskHumanBudget reports the remaining budget and resets", () => {
    resetAskHumanBudgetForTests();
    for (let i = 0; i < MAX_ASK_HUMAN_PER_RUN; i++) {
      const budget = consumeAskHumanBudget("run-x");
      expect(budget.allowed).toBe(true);
      expect(budget.remaining).toBe(MAX_ASK_HUMAN_PER_RUN - i - 1);
    }
    expect(consumeAskHumanBudget("run-x")).toEqual({ allowed: false, remaining: 0 });
    // A different run is unaffected.
    expect(consumeAskHumanBudget("run-y")).toEqual({ allowed: true, remaining: MAX_ASK_HUMAN_PER_RUN - 1 });
    resetAskHumanBudgetForTests();
    expect(consumeAskHumanBudget("run-x")).toEqual({ allowed: true, remaining: MAX_ASK_HUMAN_PER_RUN - 1 });
  });
});

