import { describe, expect, test } from "vitest";
import { focusedPageText } from "../src/lib/agent/tools/handlers/extract";

describe("focusedPageText", () => {
  test("keeps query matches with adjacent context instead of a giant page head", () => {
    const lines = Array.from({ length: 800 }, (_, i) =>
      i === 640 ? "Artemis crew includes Reid Wiseman and Victor Glover" : `unrelated navigation item ${i}`,
    );
    const result = focusedPageText(lines.join("\n"), "Find the Artemis crew names");
    expect(result).toContain("Reid Wiseman");
    expect(result).toContain("navigation item 639");
    expect(result.length).toBeLessThanOrEqual(8_040);
    expect(result).not.toContain("navigation item 20\n");
  });

  test("falls back to a bounded head and tail when no query term matches", () => {
    const result = focusedPageText("A".repeat(20_000), "unfindable zebra phrase");
    expect(result).toContain("middle omitted");
    expect(result.length).toBeLessThanOrEqual(8_050);
  });
});
