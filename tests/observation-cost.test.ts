/**
 * Behavioral observation-cost bounds.
 *
 * This suite pins the observation pipeline's steady-state wins as DETERMINISTIC
 * behavioral counters — no timers, no wall-clock, no flaky measurements. Each
 * counter is a spy over repeated IDENTICAL work:
 *
 * (a) `cachedExtractBrowserState` (skip-if-unchanged gate): on an
 *     unchanged fixture, extractions 2 and 3 perform ZERO layout reads
 *     (`getBoundingClientRect` / `getComputedStyle`) and ZERO element
 *     serializations. `serializeElement` is module-private in page-state.ts,
 *     so its invocation count is observed through
 *     `ReadCache.prototype.batchRead` — its ONLY per-element call
 *     (page-state.ts:354), the same "no DOM walk" marker state-cache.test.ts
 *     uses. A mere cross-step read cache would zero the layout reads but still
 *     walk (batchRead > 0); only the skip-if-unchanged gate zeroes both.
 * (b) `compileNavigatorPromptV1` (system-prompt memo / redaction+scan memo /
 *     incremental history): 3 compiles with byte-identical inputs rebuild
 *     the system prompt ONCE, re-redact/re-scan NOTHING, and re-render no
 *     masked history item.
 * (c) 64k-context compile with a screenshot (structured image part):
 *     `assertPromptBudgetWithImage` receives `imageChars` NUMERICALLY and the
 *     old `" ".repeat(adjustedChars)` padding allocation is gone —
 *     `String.prototype.repeat` is never invoked on the whole
 *     `navigatorCallDirect` path.
 *
 * Any counter that regresses here is a REAL finding: the owning memo key no
 * longer covers the repeated work.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedExtractBrowserState, invalidateStateCache } from "../src/lib/agent/dom/extraction/state-cache";
import { ReadCache } from "../src/lib/agent/dom/utils/read-cache";
import { installMutationSignal } from "../src/lib/agent/dom/mutation-signal";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import * as navigatorPromptModule from "../src/lib/agent/prompts/navigator-prompt";
import { clearPromptMemo } from "../src/lib/agent/prompts/prompt-memo";
import * as secretsModule from "../src/lib/agent/secrets";
import * as securityModule from "../src/lib/agent/security";
import { clearRedactionMemo } from "../src/lib/agent/redaction-memo";
import { historyItemRenderer } from "../src/lib/agent/loop/messages-utils";
import * as promptTokenBudgetModule from "../src/lib/agent/prompts/prompt-token-budget";
import type { AgentStepRequest } from "../src/lib/agent/types";
import {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
  installViewportMock,
  restoreViewportMock,
  installLocalStorageStub,
  restoreLocalStorageStub,
  makeHistoryItem,
} from "./helpers";

// Spy at the module boundary: wrap the REAL builders/redactors (so the
// byte-identity of every path stays real) while making each invocation
// countable through the whole import graph.
vi.mock("../src/lib/agent/prompts/navigator-prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/prompts/navigator-prompt")>();
  return {
    ...actual,
    buildNavigatorPrompt: vi.fn(actual.buildNavigatorPrompt),
  };
});
vi.mock("../src/lib/agent/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/secrets")>();
  return {
    ...actual,
    redactSecrets: vi.fn(actual.redactSecrets),
  };
});
vi.mock("../src/lib/agent/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/security")>();
  return {
    ...actual,
    scanForInjection: vi.fn(actual.scanForInjection),
  };
});

// Provider double for part (c): vision-capable, structured-output, countable
// chat requests — mirrors llm-direct-context-budget.test.ts.
const providerH = vi.hoisted(() => ({ chatRequests: [] as Record<string, unknown>[] }));
vi.mock("../src/extension/provider-config", () => ({
  readProviderConfig: async () => ({ provider: "openai", apiKey: "k", model: "gpt-4o-mini" }),
  resolveModel: (c: { provider?: string; model?: string; catalogId?: string }) => c.model ?? "resolved-default",
  buildProvider: async () => ({
    id: "openai",
    model: "gpt-4o-mini",
    supportsStructuredOutput: true,
    supportsVision: true,
    chat: async (req: { messages: unknown[] }) => {
      providerH.chatRequests.push(req as Record<string, unknown>);
      return { content: "{}" };
    },
  }),
}));

beforeAll(() => installLocalStorageStub());
afterAll(() => restoreLocalStorageStub());

// ─── (a) cachedExtractBrowserState: skip-if-unchanged cost bounds ────────────

describe("cachedExtractBrowserState — no re-walk, no re-layout", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    installViewportMock({ innerHeight: 800, scrollHeight: 1600, scrollY: 0 });
    installMutationSignal();
    // Deterministic start: whatever the previous test left in the module-level
    // snapshot, extraction 1 below must be a FRESH walk.
    invalidateStateCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    installMutationSignal();
    restoreJsdomLayoutMock();
    restoreViewportMock();
  });

  it("extractions 2 and 3 on an unchanged fixture do zero layout reads and zero element serializations", () => {
    document.body.innerHTML =
      "<button id='a'>Alpha</button><button id='b'>Beta</button><a href='/x'>Link</a>";
    const first = cachedExtractBrowserState([]);
    expect(first.elements.length).toBeGreaterThan(0);

    // Extraction 1 ran the walk. Extractions 2-3 must run NOTHING:
    // - getBoundingClientRect / getComputedStyle: zero layout reads;
    // - ReadCache.prototype.batchRead: serializeElement's only per-element
    //   call (page-state.ts:354) — zero invocations == zero serializations.
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const styleSpy = vi.spyOn(window, "getComputedStyle");
    const serializeSpy = vi.spyOn(ReadCache.prototype, "batchRead");

    const second = cachedExtractBrowserState([]);
    const third = cachedExtractBrowserState([]);

    expect(rectSpy).not.toHaveBeenCalled();
    expect(styleSpy).not.toHaveBeenCalled();
    expect(serializeSpy).not.toHaveBeenCalled();
    // Both hits serve the SAME deep-frozen snapshot, byte-identical to the
    // fresh extract.
    expect(second).toBe(third);
    expect(second.elementsText).toBe(first.elementsText);
    expect(second.elements.length).toBe(first.elements.length);
  });
});

// ─── (b) compileNavigatorPromptV1: memo cost bounds ──────────────────────────

describe("compileNavigatorPromptV1 — memo cost bounds", () => {
  const history = Array.from({ length: 6 }, (_, i) =>
    makeHistoryItem(i, {
      results: i % 2 === 0
        ? [{
            action: { type: "click", index: i } as AgentStepRequest["history"][number]["results"][number]["action"],
            success: true,
            message: `message-${i}`,
            extractedContent: `extracted-${i}`,
          }]
        : [],
    }),
  );

  // Identical input for all 3 compiles: same task, same history object
  // references, same browserState strings.
  const input = {
    maxActions: 5,
    compact: true,
    user: {
      task: "Verify the memo cost bounds",
      history,
      currentGoal: "Current goal",
      plan: ["plan a", "plan b", "plan c"],
      currentPlanItem: 1,
      browserState: {
        url: "https://example.com/docs",
        title: "Documentation",
        tabs: [{ id: 1, label: "1", url: "https://example.com/docs", title: "Documentation", active: true }],
        elementsText: "[1]<button>Continue</button>\n[2]<input name='q'>",
        pageInfo: "0 pages above, 1 page below",
        newElementCount: 0,
        axTree: "button Continue\ninput q",
      },
      step: 4,
      maxSteps: 10,
      compactedMemory: "earlier steps summarized",
    },
  };

  beforeEach(() => {
    clearPromptMemo();
    clearRedactionMemo();
  });

  it("3 compiles with identical inputs: one system build, zero re-redaction/re-scan, one masked-prefix render", async () => {
    const systemSpy = vi.spyOn(navigatorPromptModule, "buildNavigatorPrompt");
    const renderSpy = vi.spyOn(historyItemRenderer, "render");
    const redactSpy = vi.mocked(secretsModule.redactSecrets);
    const scanSpy = vi.mocked(securityModule.scanForInjection);
    systemSpy.mockClear();
    renderSpy.mockClear();
    try {
      const first = await compileNavigatorPromptV1(input);
      // Compile 1 is the only one that may do real work — and must.
      expect(systemSpy).toHaveBeenCalledTimes(1);
      const redactionsAfterFirst = redactSpy.mock.calls.length;
      const scansAfterFirst = scanSpy.mock.calls.length;
      expect(redactionsAfterFirst).toBeGreaterThan(0);
      expect(scansAfterFirst).toBeGreaterThan(0);

      const second = await compileNavigatorPromptV1(input);
      const third = await compileNavigatorPromptV1(input);

      // The system prompt (build + provider suffix) is rebuilt ONCE;
      // compiles 2-3 are pure memo hits.
      expect(systemSpy).toHaveBeenCalledTimes(1);

      // Compiles 2-3 redact and injection-scan NOTHING: every page field
      // (elementsText/title/url/tabs/pageInfo/axTree), the compacted-memory
      // block, and every history item are memo hits.
      expect(redactSpy.mock.calls.length).toBe(redactionsAfterFirst);
      expect(scanSpy.mock.calls.length).toBe(scansAfterFirst);

      // The 4 masked (stale-observation) history items render exactly
      // ONCE across all 3 compiles (memoized masked prefix + per-item cache);
      // only the 2 retention-window items re-render per compile.
      const byStep = new Map<number, number>();
      for (const [h] of renderSpy.mock.calls) {
        byStep.set(h.step, (byStep.get(h.step) ?? 0) + 1);
      }
      expect(byStep.get(0)).toBe(1);
      expect(byStep.get(1)).toBe(1);
      expect(byStep.get(2)).toBe(1);
      expect(byStep.get(3)).toBe(1);
      expect(byStep.get(4)).toBe(3);
      expect(byStep.get(5)).toBe(3);

      // Memoization must never change observable bytes: all 3 compiles ship
      // identical system + user content.
      expect(second.messages[0].content).toBe(first.messages[0].content);
      expect(third.messages[0].content).toBe(first.messages[0].content);
      expect(second.messages[1].content).toBe(first.messages[1].content);
      expect(third.messages[1].content).toBe(first.messages[1].content);
    } finally {
      systemSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });
});

// ─── (c) 64k-context compile with a screenshot: structured image budget ──────

describe("64k-context compile with a screenshot — numeric image budget", () => {
  beforeEach(() => {
    providerH.chatRequests = [];
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.resetModules();
  });

  it("the full navigator path runs the image budget with a 700k-char base64 and allocates no ' '.repeat padding", async () => {
    const store: Record<string, unknown> = { contextTokens: 64_000, enableScreenshots: true };
    const get = (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const k of arr) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: { get, set: () => Promise.resolve() },
        onChanged: { addListener: () => undefined },
      },
    };

    const llmDirect = await import("../src/extension/llm-direct");
    // A full-viewport base64 payload: ~700k chars. The flat token allowance
    // keeps this inside the 64k-derived input budget — and the old
    // `" ".repeat(adjustedChars)` measurement would have allocated a ~700k-char
    // string per step for it.
    const screenshot = "data:image/png;base64," + "A".repeat(700_000);
    const request: AgentStepRequest = {
      task: "Observe the page",
      history: [],
      currentGoal: "Read the page",
      plan: ["Observe", "Report"],
      currentPlanItem: 0,
      browserState: {
        url: "https://example.com",
        title: "Example",
        tabs: [],
        elementsText: "small page",
        pageInfo: "",
        newElementCount: 0,
        screenshot,
      },
      step: 0,
      maxSteps: 10,
    };

    // `assertPromptBudgetWithImage` is module-private and called same-module
    // (not namespace-interceptable). Its two observable cross-module seams:
    // `promptBudgetProfileForContextV1` runs ONLY inside the image path, while
    // the plain context assert runs ONLY when no image is attached — so which
    // of the two ran identifies which budget path was taken.
    const profileSpy = vi.spyOn(promptTokenBudgetModule, "promptBudgetProfileForContextV1");
    const plainAssertSpy = vi.spyOn(promptTokenBudgetModule, "assertCompiledPromptWithinContextBudgetV1");
    // The `" ".repeat(adjustedChars)` allocation removed with the numeric
    // image budget: any call here is a cost regression regardless of whether
    // the guard still passes.
    const repeatSpy = vi.spyOn(String.prototype, "repeat");
    try {
      const result = await llmDirect.navigatorCallDirect(request);

      // The 700k-char screenshot is counted NUMERICALLY (base64 chars
      // subtracted, flat token allowance added), so the 64k guard passes and
      // the provider is reached — no false fail-closed trip.
      expect(providerH.chatRequests.length).toBe(1);
      expect(result).toBeDefined();

      // The image path (assertPromptBudgetWithImage) ran at the 64k regime:
      // the profile lookup was made and the plain context assert did NOT run.
      expect(profileSpy).toHaveBeenCalledTimes(1);
      expect(profileSpy).toHaveBeenCalledWith("navigator", 64_000);
      expect(plainAssertSpy).not.toHaveBeenCalled();

      // The screenshot traveled as a STRUCTURED image part on the user message.
      const chatMessages = providerH.chatRequests[0].messages as unknown as Array<{ content: unknown }>;
      const userContent = chatMessages?.[1]?.content as unknown[];
      expect(Array.isArray(userContent)).toBe(true);
      const lastPart = (userContent as { type?: string }[]).at(-1);
      expect(lastPart?.type).toBe("image");

      // No " ".repeat padding allocation on the whole compile+budget path.
      expect(repeatSpy).not.toHaveBeenCalled();
    } finally {
      profileSpy.mockRestore();
      plainAssertSpy.mockRestore();
      repeatSpy.mockRestore();
    }
  });

  it("assertPromptBudget with a numeric imageChars subtracts the base64 without allocating padding", async () => {
    // Drive the compile seam directly: a 64k-compact navigator compile carrying
    // a structured screenshot part (the exact shape navigatorCallDirect builds).
    const screenshot = "data:image/png;base64," + "B".repeat(700_000);
    const imagePart = {
      type: "image" as const,
      dataUrl: screenshot,
      mime: "image/png",
      chars: screenshot.length,
    };
    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      compact: true,
      screenshot: imagePart,
      user: {
        task: "Observe",
        history: [],
        currentGoal: "Read",
        plan: ["Observe"],
        currentPlanItem: 0,
        browserState: {
          url: "https://example.com",
          title: "Example",
          tabs: [],
          elementsText: "small page",
          pageInfo: "",
          newElementCount: 0,
        },
        step: 0,
        maxSteps: 10,
      },
    });

    const { assertPromptBudget } = await import("../src/extension/llm-direct");
    const repeatSpy = vi.spyOn(String.prototype, "repeat");
    try {
      // `imageChars` arrives NUMERICALLY (base64 char count, no padded string):
      // the guard passes for a 700k-char payload because the chars are
      // SUBTRACTED, not measured through an allocation.
      expect(() =>
        assertPromptBudget("navigator", "nav-64k-image", compiled.messages, 64_000, {
          imageChars: imagePart.chars,
          imageTokens: 4096,
        }),
      ).not.toThrow();
      expect(repeatSpy).not.toHaveBeenCalled();
    } finally {
      repeatSpy.mockRestore();
    }
  });
});