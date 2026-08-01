/**
 * flexibleBoolean tests — null coercion semantics and JSON Schema
 * convertibility (the agent's real output schema must survive the
 * strict-schema path, which `.transform()` broke).
 */

import { describe, test, expect } from "vitest";
import { flexibleBoolean } from "../src/lib/agent/tools/schema-utils";
import { AgentOutputSchema, InputSchema, NavigateSchema } from "../src/lib/agent/tools/schema";
import { zodToJsonSchema } from "../src/lib/agent/llm/zod-json-schema";

describe("flexibleBoolean — null maps to the documented field default", () => {
  test("explicit null yields the documented default for a true-defaulted field (clear)", () => {
    const out = InputSchema.parse({ type: "input", index: 1, text: "hi", clear: null });
    expect(out.clear).toBe(true);
  });

  test("explicit null yields the documented default for a false-defaulted field (new_tab)", () => {
    const out = NavigateSchema.parse({ type: "navigate", url: "https://example.com", new_tab: null });
    expect(out.new_tab).toBe(false);
  });

  test("missing value still yields the field default", () => {
    const out = InputSchema.parse({ type: "input", index: 1, text: "hi" });
    expect(out.clear).toBe(true);
  });
});

describe("flexibleBoolean — coercion without the truthy-string trap", () => {
  test("string/number booleans coerce to real booleans", () => {
    expect(flexibleBoolean.parse("true")).toBe(true);
    expect(flexibleBoolean.parse("false")).toBe(false);
    expect(flexibleBoolean.parse(1)).toBe(true);
    expect(flexibleBoolean.parse(0)).toBe(false);
    expect(flexibleBoolean.parse("TRUE")).toBe(true);
    expect(flexibleBoolean.parse("False")).toBe(false);
  });

  test("unknown values are still rejected", () => {
    expect(flexibleBoolean.safeParse("garbage").success).toBe(false);
    expect(flexibleBoolean.safeParse(2).success).toBe(false);
  });
});

describe("flexibleBoolean — JSON Schema conversion (T3 probe)", () => {
  test("zodToJsonSchema(AgentOutputSchema) succeeds and yields a plain JSON Schema", async () => {
    const js = (await zodToJsonSchema(AgentOutputSchema)) as Record<string, unknown>;
    expect(js.type).toBe("object");
    expect(typeof js.properties).toBe("object");
  });
});
