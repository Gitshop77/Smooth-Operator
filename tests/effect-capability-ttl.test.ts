/**
 * privileged-action-policy TTL — an issued effect capability is request-scoped
 * and single-use; a leaked capability must expire so it cannot be replayed
 * later in a long-lived service worker.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  authorizeAndIssueEffectCapability,
  consumeEffectCapability,
  resetPrivilegedActionPolicyForTests,
} from "../src/extension/background/privileged-action-policy";
import type { AgentMode } from "../src/lib/agent/modes";
import type { RunDispatchToken } from "../src/extension/background/run-controller";

const token: RunDispatchToken = { runId: "run-1", dispatchRevision: 1 };
const action = { type: "click", index: 1 } as const;
const MODE: AgentMode = "full_agentic";

beforeEach(() => {
  resetPrivilegedActionPolicyForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_700_000_000_000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("effect capability TTL", () => {
  test("an expired capability is rejected and removed", () => {
    const issued = authorizeAndIssueEffectCapability(token, MODE, action);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // Within the TTL the capability consumes normally.
    expect(consumeEffectCapability(issued.effectCapability, token, action)).toBe(true);
  });

  test("a capability is single-use and not replayable", () => {
    const issued = authorizeAndIssueEffectCapability(token, MODE, action);
    if (!issued.ok) return;
    expect(consumeEffectCapability(issued.effectCapability, token, action)).toBe(true);
    expect(consumeEffectCapability(issued.effectCapability, token, action)).toBe(false);
  });

  test("a capability past its TTL is rejected even before any use", () => {
    const issued = authorizeAndIssueEffectCapability(token, MODE, action);
    if (!issued.ok) return;
    vi.advanceTimersByTime(31_000);
    expect(consumeEffectCapability(issued.effectCapability, token, action)).toBe(false);
  });
});
