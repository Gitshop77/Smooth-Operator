/**
 * Shared describeAction assertions for the "newer" action types (takeover,
 * verify, load_skill, ask_human). Extracted so executor.test.ts and
 * executor-actions.test.ts assert the semantic behavior exactly once instead
 * of copy-pasting the same four tests.
 */

import { describe, test, expect } from "vitest";
import { describeAction } from "../../src/lib/agent/tools/executor";
import type { AgentAction } from "../../src/lib/agent/types";

export function testDescribeActionNewerTypes(): void {
  describe("describeAction — newer action types", () => {
    test("takeover surfaces the reason", () => {
      const desc = describeAction({ type: "takeover", reason: "Login required" } as AgentAction);
      expect(desc).toContain("takeover");
      expect(desc).toContain("Login required");
    });

    test("verify surfaces the expectation", () => {
      const desc = describeAction({ type: "verify", expectation: "success message visible" } as AgentAction);
      expect(desc).toContain("verify");
      expect(desc).toContain("success message visible");
    });

    test("load_skill surfaces the skill name", () => {
      const desc = describeAction({ type: "load_skill", name: "GitHub" } as AgentAction);
      expect(desc).toContain("load_skill");
      expect(desc).toContain("GitHub");
    });

    test("ask_human surfaces the question", () => {
      const desc = describeAction({ type: "ask_human", question: "Which option?" } as AgentAction);
      expect(desc).toContain("ask_human");
      expect(desc).toContain("Which option?");
    });
  });
}
