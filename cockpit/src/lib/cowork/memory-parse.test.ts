import { describe, it, expect } from "vitest";
import {
  SENSITIVE_FIELD,
  maskValue,
  parseSiteData,
  parseFormEntries,
} from "./memory-parse";

describe("maskValue / SENSITIVE_FIELD", () => {
  it("masks values whose field name looks sensitive", () => {
    expect(maskValue("password", "hunter2")).toBe("••••••");
    expect(maskValue("cardNumber", "4111111111111111")).toBe("••••••");
    expect(maskValue("cvv", "123")).toBe("••••••");
  });

  it("passes through values whose field name is not sensitive", () => {
    expect(maskValue("username", "bob")).toBe("bob");
    expect(maskValue("title", "Invoice")).toBe("Invoice");
  });

  it("matches the documented sensitive field substrings", () => {
    expect(SENSITIVE_FIELD.test("cvv")).toBe(true);
    expect(SENSITIVE_FIELD.test("cardNumber")).toBe(true);
    expect(SENSITIVE_FIELD.test("ssn")).toBe(true);
    expect(SENSITIVE_FIELD.test("otp")).toBe(true);
    expect(SENSITIVE_FIELD.test("user_api_token")).toBe(true);
    expect(SENSITIVE_FIELD.test("username")).toBe(false);
  });
});

describe("parseFormEntries", () => {
  it("returns the entries shape when present", () => {
    const json = JSON.stringify({
      entries: [
        { field: "email", value: "a@b.com" },
        { field: "password", value: "secret" },
      ],
    });
    expect(parseFormEntries({ formDataJson: json })).toEqual([
      { field: "email", value: "a@b.com" },
      { field: "password", value: "secret" },
    ]);
  });

  it("falls back to flattening top-level string/number keys", () => {
    const json = JSON.stringify({ q: "hello", n: 42, nested: { a: 1 } });
    expect(parseFormEntries({ formDataJson: json })).toEqual([
      { field: "q", value: "hello" },
      { field: "n", value: "42" },
    ]);
  });

  it("returns an empty array on empty/malformed input without throwing", () => {
    expect(parseFormEntries({ formDataJson: "" })).toEqual([]);
    expect(parseFormEntries({ formDataJson: "{not json" })).toEqual([]);
  });
});

describe("parseSiteData", () => {
  it("computes visit/diff counts and a full preview when short", () => {
    const data = { visits: [1, 2, 3], diffs: [1], note: "x" };
    const json = JSON.stringify(data);
    const out = parseSiteData({ dataJson: json });
    expect(out.visitCount).toBe(3);
    expect(out.diffCount).toBe(1);
    expect(out.preview).toBe(json);
  });

  it("caps long previews at 120 chars with an ellipsis", () => {
    const json = JSON.stringify({ big: "y".repeat(200) });
    expect(json.length).toBeGreaterThan(120);
    const out = parseSiteData({ dataJson: json });
    expect(out.preview.length).toBe(121);
    expect(out.preview.endsWith("…")).toBe(true);
  });

  it("never throws on malformed JSON and returns empty counts", () => {
    const out = parseSiteData({ dataJson: "{bad" });
    expect(out).toEqual({ visitCount: 0, diffCount: 0, preview: "{bad" });
  });

  it("returns empty result for missing/empty dataJson", () => {
    expect(parseSiteData({ dataJson: "" })).toEqual({
      visitCount: 0,
      diffCount: 0,
      preview: "",
    });
  });
});
