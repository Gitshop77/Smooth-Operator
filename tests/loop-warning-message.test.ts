/**
 * The navigator user message must render the loop-warning block.
 *
 * The loop builds a `pendingLoopWarning` (`<sys>`-block with budget/replan/
 * loop-detect/force-done nudges, or a `<sys><parse_error>` block on retries)
 * and carries it on `AgentStepRequest.loopWarning` — but
 * `buildNavigatorUserMessage` had no parameter for it, so the model never saw
 * the budget warnings, the force-done "only done tool" instruction, captcha/
 * downloads guidance, or parse-error feedback (retries resend an identical
 * prompt, making `MAX_PARSE_RETRIES` inert).
 *
 * The producers (`injection-points.ts`, `llm-calls.ts`) already sanitize and
 * emit fully-formed `<sys>...</sys>` blocks, so the renderer must pass the
 * block through VERBATIM — not through `wrapUntrusted` (whose
 * `sanitizeUntrusted` redacts tag-shaped content) and not through
 * `redactBoth`. A verbatim `toContain(warning)` assertion locks that in.
 */

import { describe, test, expect, vi } from "vitest";
import { buildNavigatorUserMessage } from "../src/lib/agent/loop/messages";
import { callNavigatorWithRetry } from "../src/lib/agent/loop/helpers/llm-calls";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest } from "../src/lib/agent/types";
import type { CallbackContext, CallbackDispatcher } from "../src/lib/agent/callbacks";

const baseArgs = {
  task: "test task",
  history: [],
  currentGoal: "do the thing",
  plan: ["a", "b"],
  currentPlanItem: 0,
  browserState: {
    url: "https://example.com",
    title: "Example",
    tabs: [],
    elementsText: "content",
    pageInfo: "",
    newElementCount: 0,
  },
  step: 0,
  maxSteps: 10,
};

describe("buildNavigatorUserMessage — loop-warning rendering", () => {
  test("renders the loopWarning block verbatim when provided", async () => {
    // Mirrors loop-detector.ts's real nudge text (assembled into the `<sys>`
    // block by injection-points.ts before it lands on the request).
    const warning =
      "<sys>LOOP DETECTED: you have taken an equivalent action 5 times in the recent window " +
      "without making progress. Try a DIFFERENT approach: scroll to find new elements, " +
      "switch strategy, or if truly stuck, call done(success=false) with an explanation.</sys>";

    const out = await buildNavigatorUserMessage({ ...baseArgs, loopWarning: warning });

    // Verbatim inclusion: if the block were wrapped in wrapUntrusted, passed
    // through redactBoth, or escapeXml'd, the exact string would not appear.
    expect(out).toContain(warning);
    // Exactly once — no duplicate or empty `<sys>` shells.
    expect(out.split(warning).length - 1).toBe(1);
  });

  test("emits no sys block when loopWarning is absent", async () => {
    const out = await buildNavigatorUserMessage(baseArgs);

    // With empty history and a clean page, nothing else renders a `<sys>`
    // block — an absent warning must stay absent (no empty placeholder).
    expect(out).not.toContain("<sys>");
  });
});

// ─── callNavigatorWithRetry — parse-error retry content redaction ────────────
//
// The retry loopWarning block echoes the RAW model output and parse error
// back into the next navigator prompt. A model that echoed a substituted
// secret (page content rendered into the assistant turn) would otherwise
// ship that secret to the provider a second time. Key-shape redaction runs
// before the block is assembled, and on the raw content passed to the
// dispatcher's llmEnd callback (side-panel transcript).

describe("callNavigatorWithRetry — parse-error retry content redaction", () => {
  test("a credential echoed by the model is redacted from the retry loopWarning and llmEnd content", async () => {
    const key = "AKIA0123456789ABCDEF";
    const unparseable = `raw garbage echoing ${key}`;
    const navigatorCall = vi
      .fn()
      .mockResolvedValueOnce({
        raw: unparseable,
        tokensIn: 10,
        tokensOut: 5,
      })
      .mockResolvedValueOnce({
        raw: `{"thinking":"ok","evaluation_previous_goal":"","memory":"","next_goal":"","action":[{"type":"click","index":1}]}`,
        tokensIn: 10,
        tokensOut: 5,
      });
    const llmEnd = vi.fn();
    const deps = {
      onEvent: vi.fn(),
      onCost: vi.fn(),
      navigatorCall,
    } as unknown as LoopDeps;
    const dispatcher = {
      llmStart: vi.fn(),
      llmEnd,
      cost: vi.fn(),
    } as unknown as CallbackDispatcher;
    const request: AgentStepRequest = {
      task: "test task",
      history: [],
      browserState: {
        url: "https://example.com",
        title: "Example",
        tabs: [],
        elementsText: "content",
        pageInfo: "",
        newElementCount: 0,
      },
      step: 0,
      maxSteps: 5,
    };

    await callNavigatorWithRetry(
      deps,
      request,
      0,
      vi.fn(),
      dispatcher,
      {} as CallbackContext,
      new AbortController().signal,
      100,
    );

  // The retry request carries the parse-error feedback, but without the raw
  // credential (the retry prompt is another outbound provider call).
    const retryRequest = navigatorCall.mock.calls[1][0] as AgentStepRequest;
    expect(retryRequest.loopWarning).toContain("<parse_error>");
    expect(retryRequest.loopWarning).not.toContain(key);
  // The dispatcher transcript must not receive the raw credential either.
    const llmEndContent = (llmEnd.mock.calls.at(-1)?.[1] as { content: string }).content;
    expect(llmEndContent).not.toContain(key);
  });
});
