import { describe, it, expect } from "vitest";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { ACTION_METADATA } from "../src/lib/agent/tools/schema-utils";
import { checkActionAllowed } from "../src/lib/agent/modes";
import { describeAction } from "../src/lib/agent/tools/describe";

describe("research action", () => {
  it("validates query", () => {
    expect(ActionSchema.safeParse({ type: "research", query: "latest news" }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "research" }).success).toBe(false);
  });
  it("has metadata, is exclusive and not page-changing", () => {
    const meta = ACTION_METADATA.research;
    expect(meta).toBeDefined();
    expect(meta.pageChanging).toBe(false);
    expect(meta.exclusive).toBe(true);
  });
  it("is blocked in restricted mode, allowed in standard and full_agentic", () => {
    expect(checkActionAllowed("research", "restricted").allowed).toBe(false);
    expect(checkActionAllowed("research", "standard").allowed).toBe(true);
    expect(checkActionAllowed("research", "full_agentic").allowed).toBe(true);
  });
  it("describes", () => {
    expect(describeAction({ type: "research", query: "q" } as never)).toBe("research: q");
  });
});