/**
 * F-09: `find_elements` must not leak sensitive attribute values.
 *
 * The handler routes attribute extraction through `isSensitive` (the same
 * classifier used by the DOM extractor's `buildAttrs`) and `redactSecrets`, so
 * a password / OTP / credit-card `value` is redacted to `[value redacted]`
 * while non-sensitive attributes are returned verbatim.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { handleFindElements } from "../src/lib/agent/tools/handlers/find-elements";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";

const DUMMY_CTX = {} as ActionContext;

describe("find_elements sensitive-attribute redaction (F-09)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="pw" type="password" value="supersecret">
      <input id="otp" type="text" autocomplete="one-time-code" value="000999">
      <input id="cc" type="text" autocomplete="cc-number" value="4111111111111111">
      <input id="name" type="text" value="alice">
      <div id="d" data-x="meta-info">hi</div>
    `;
  });

  test("redacts password / OTP / credit-card value but keeps non-sensitive attrs", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "input, div",
      attributes: ["value", "data-x"],
      max_results: 50,
    });
    expect(res.success).toBe(true);
    const out = res.extractedContent ?? "";

    // Sensitive `value`s are redacted — the raw secrets must NOT appear.
    expect(out).toContain("[value redacted]");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("000999");
    expect(out).not.toContain("4111111111111111");

    // Non-sensitive value + attribute are returned verbatim.
    expect(out).toContain("alice");
    expect(out).toContain("meta-info");
  });

  test("returns the real value for a non-sensitive input", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "#name",
      attributes: ["value"],
      max_results: 50,
    });
    expect(res.extractedContent).toContain('"value":"alice"');
  });

  test("preserves behavior for non-sensitive attributes when no value requested", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "#d",
      attributes: ["data-x"],
      max_results: 50,
    });
    expect(res.extractedContent).toContain('"data-x":"meta-info"');
  });
});
