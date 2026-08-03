/**
 * list_downloads action tests — schema, wiring (describe / normalize / mode
 * gating), and the executor's non-extension fallback. The extension-context
 * RPC path is exercised end-to-end in download-capture.test.ts.
 */

import { describe, test, expect } from "vitest";
import { executeAction, describeAction } from "../src/lib/agent/tools/executor";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { normalizeAction } from "../src/lib/agent/loop/normalize-action";
import { checkActionAllowed } from "../src/lib/agent/modes";
import { isEquivalentAction } from "../src/lib/agent/tools/schema-utils";
import type { AgentAction } from "../src/lib/agent/types";
import { makeState } from "./helpers";

describe("list_downloads schema", () => {
  test("parses without parameters", () => {
    const parsed = ActionSchema.parse({ type: "list_downloads" });
    expect(parsed.type).toBe("list_downloads");
  });
});

describe("list_downloads wiring", () => {
  test("is described and normalized", () => {
    expect(describeAction({ type: "list_downloads" } as AgentAction)).toContain("list");
    expect(normalizeAction({ type: "list_downloads" } as AgentAction)).toBe("list_downloads");
  });

  test("equivalent actions compare equal", () => {
    const a = { type: "list_downloads" } as AgentAction;
    const b = { type: "list_downloads" } as AgentAction;
    expect(isEquivalentAction(a, b)).toBe(true);
  });

  test("is allowed in every mode (read-only SW ring lookup)", () => {
    for (const mode of ["restricted", "standard", "full_agentic"] as const) {
      expect(checkActionAllowed("list_downloads", mode).allowed).toBe(true);
    }
  });
});

describe("list_downloads executor", () => {
  test("fails cleanly without an extension context", async () => {
    const result = await executeAction({ type: "list_downloads" }, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("requires the extension context");
  });
});
