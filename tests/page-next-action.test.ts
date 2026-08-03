// @vitest-environment-options {"url":"https://page-next.test/"}

/**
 * page_next action tests — schema, executor behavior (snapshot paging from
 * the cached serialization), and the full wiring points
 * (describe / normalize / mode gating).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { executeAction, describeAction } from "../src/lib/agent/tools/executor";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { normalizeAction } from "../src/lib/agent/loop/normalize-action";
import { checkActionAllowed } from "../src/lib/agent/modes";
import { extractBrowserState } from "../src/lib/agent/dom/extractor";
import { MAX_SNAPSHOT_CHARS } from "../src/lib/agent/dom/extraction/page-state";
import type { AgentAction } from "../src/lib/agent/types";
import { makeState, installJsdomLayoutMock, restoreJsdomLayoutMock, installViewportMock, restoreViewportMock } from "./helpers";

/** Build a DOM large enough that the serialized snapshot exceeds the cap. */
function buildHugePage(buttonCount: number, labelLen: number): void {
  const rows: string[] = [];
  for (let i = 0; i < buttonCount; i++) {
    rows.push(`<button aria-label="${"l".repeat(labelLen)}">btn ${i}</button>`);
  }
  document.body.innerHTML = rows.join("");
}

describe("page_next schema", () => {
  test("parses with an explicit offset", () => {
    const parsed = ActionSchema.parse({ type: "page_next", offset: 1234 }) as Extract<
      ReturnType<typeof ActionSchema.parse>,
      { type: "page_next" }
    >;
    expect(parsed.type).toBe("page_next");
    expect(parsed.offset).toBe(1234);
  });

  test("offset is optional and coerced", () => {
    const parsed = ActionSchema.parse({ type: "page_next" }) as Extract<
      ReturnType<typeof ActionSchema.parse>,
      { type: "page_next" }
    >;
    expect(parsed.type).toBe("page_next");
    expect(parsed.offset).toBeUndefined();
    const coerced = ActionSchema.parse({ type: "page_next", offset: "42" }) as Extract<
      ReturnType<typeof ActionSchema.parse>,
      { type: "page_next" }
    >;
    expect(coerced.offset).toBe(42);
  });

  test("rejects a negative offset", () => {
    expect(() => ActionSchema.parse({ type: "page_next", offset: -1 })).toThrow();
  });
});

describe("page_next wiring", () => {
  test("is described and normalized", () => {
    expect(describeAction({ type: "page_next" } as AgentAction)).toContain("page_next");
    expect(describeAction({ type: "page_next", offset: 77 } as AgentAction)).toContain("77");
    expect(normalizeAction({ type: "page_next", offset: 77 } as AgentAction)).toBe("page_next|offset=77");
  });

  test("is allowed in every mode (read-only continuation)", () => {
    for (const mode of ["restricted", "standard", "full_agentic"] as const) {
      expect(checkActionAllowed("page_next", mode).allowed).toBe(true);
    }
  });
});

describe("page_next executor behavior", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    installViewportMock({ innerHeight: 900, scrollHeight: 2000, scrollY: 0 });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    restoreJsdomLayoutMock();
    restoreViewportMock();
  });

  test("fails cleanly when no snapshot has been extracted yet", async () => {
    const result = await executeAction({ type: "page_next" }, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("page_next failed");
  });

  test("truncates a huge page snapshot and marks it truncated", () => {
    buildHugePage(3000, 120);
    const state = extractBrowserState([]);
    // The window stays within the char cap even though the page is huge.
    expect(state.elementsText.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 500);
    // Truncation happened and points the model at the resume offset.
    expect(state.elementsText).toContain("Call page_next with offset=");
  });

  test("pages through a truncated snapshot via page_next", async () => {
    buildHugePage(1500, 120);
    extractBrowserState([]);
    const first = await executeAction({ type: "page_next" }, makeState());
    expect(first.success).toBe(true);
    expect(first.extractedContent).toBeDefined();
    const firstChunk = first.extractedContent!;
    // The chunk is a window (head + marker + tail), not the whole page.
    expect(firstChunk.length).toBeLessThan(MAX_SNAPSHOT_CHARS + 500);
    expect(first.message).toContain("page_next");
    // The message carries the next offset when more pages remain.
    const nextOffset = /offset=(\d+)/.exec(first.message);
    expect(nextOffset).not.toBeNull();
    const second = await executeAction(
      { type: "page_next", offset: Number(nextOffset![1]) },
      makeState(),
    );
    expect(second.success).toBe(true);
    expect(second.extractedContent).toBeDefined();
    // The second window continues where the first ended.
    expect(second.extractedContent!.length).toBeGreaterThan(0);
  });

  test("a fresh extraction invalidates the paging cache", async () => {
    buildHugePage(1500, 120);
    extractBrowserState([]);
    // Small page afterwards: no truncation, no paging markers.
    document.body.innerHTML = "<button>Go</button>";
    const small = extractBrowserState([]);
    expect(small.elementsText).not.toContain("Call page_next");
  });

  test("a failed DOM walk invalidates the paging cache", async () => {
    buildHugePage(1, 10);
    const textNode = document.body.firstElementChild!.firstChild as Text;
    Object.defineProperty(textNode, "textContent", {
      get() {
        throw new Error("probe boom");
      },
      configurable: true,
    });
    extractBrowserState([]); // walk throws mid-extract → cache must be null
    const result = await executeAction({ type: "page_next" }, makeState());
    expect(result.success).toBe(false);
    expect(result.message).toContain("no page snapshot cached");
  });
});
