/**
 * P2 — the loop's action-queue surfaces the retryable/recovery vocabulary
 * when a tab-level action delegation throws an error that carries
 * machineCode/recoveryHint (e.g. the executor's UnhandledActionError, which
 * `runLocalAction` flattens into a routine failed ActionResult).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { executeActionQueue } from "../src/lib/agent/loop/helpers/action-queue";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { CallbackDispatcher, CallbackContext } from "../src/lib/agent/callbacks";
import type { AgentConfig } from "../src/lib/agent/types";
import { makeState } from "./helpers";

const BASE_CONFIG: AgentConfig = {
  maxSteps: 10,
  maxActionsPerStep: 10,
  plannerInterval: 100,
  maxFailures: 3,
  enableLoopDetection: false,
  enableCompaction: false,
  compactionStepInterval: 1000,
  compactionCharThreshold: 1_000_000,
  enableJudge: false,
  enableEarlyStop: false,
  costCapUsd: undefined,
} as never;

describe("action queue — error vocabulary in failed results", () => {
  let deps: LoopDeps;

  beforeEach(() => {
    deps = {
      task: "t",
      navigatorCall: vi.fn(),
      plannerCall: vi.fn(),
      onEvent: vi.fn(),
      signal: undefined,
      onTabAction: vi.fn(async () => {
        throw Object.assign(new Error("unhandled action type: bogus"), {
          machineCode: "action_unsupported",
          retryable: false,
          recoveryHint: "This action type is not supported.",
        });
      }),
    } as unknown as LoopDeps;
  });

  test("a tab-action throw with machineCode/recoveryHint surfaces the suffix in the result message", async () => {
    const result = await executeActionQueue(
      deps,
      [{ type: "navigate", url: "https://example.com", new_tab: false }] as never,
      makeState(),
      1,
      "standard",
      new LoopDetector(),
      BASE_CONFIG,
      undefined as unknown as CallbackDispatcher,
      undefined as unknown as CallbackContext,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].message).toContain("Error: unhandled action type: bogus");
    expect(result.results[0].message).toContain("[code: action_unsupported; retryable: no]");
    expect(result.results[0].message).toContain("(recovery: This action type is not supported.)");
  });

  test("a plain throw without the vocabulary fields keeps the original message", async () => {
    deps.onTabAction = vi.fn(async () => {
      throw new Error("plain failure");
    });
    const result = await executeActionQueue(
      deps,
      [{ type: "navigate", url: "https://example.com", new_tab: false }] as never,
      makeState(),
      1,
      "standard",
      new LoopDetector(),
      BASE_CONFIG,
      undefined as unknown as CallbackDispatcher,
      undefined as unknown as CallbackContext,
    );
    expect(result.results[0].message).toBe("Error: plain failure");
  });
});
