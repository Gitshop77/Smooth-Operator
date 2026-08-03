/**
 * Extension half — `navigatorCallDirect` must forward
 * `req.loopWarning` into `buildNavigatorUserMessage`.
 *
 * The loop writes `AgentStepRequest.loopWarning` (see navigator.ts /
 * llm-calls.ts) but the direct-call path never forwarded it, silently
 * dropping the budget/replan/loop-detect/force-done nudges and the
 * parse-error retry feedback before they reached the message builder.
 *
 * This test spies on the real `buildNavigatorUserMessage` (mocked module,
 * llm-direct-race pattern) and asserts the request's loopWarning arrives in
 * the builder args untouched.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentStepRequest } from "../src/lib/agent/types";

const h = vi.hoisted(() => ({
  userArgs: [] as unknown[],
}));

vi.mock("../src/lib/agent/loop/messages", () => ({
  buildNavigatorUserMessage: async (args: unknown) => {
    h.userArgs.push(args);
    return "USER";
  },
  buildPlannerUserMessage: async () => "PLANNER_USER",
}));

vi.mock("../src/lib/agent/prompts/navigator-prompt", () => ({
  buildNavigatorPrompt: () => "SYSTEM",
}));

vi.mock("../src/lib/agent/prompts/planner-prompt", () => ({
  buildPlannerPrompt: () => "PLANNER",
}));

vi.mock("../src/extension/provider-config", () => ({
  readProviderConfig: async () => ({
    provider: "openai",
    apiKey: "key",
    model: "model",
  }),
  resolveModel: (cfg: { provider?: string; model?: string; catalogId?: string }) =>
    cfg.model ?? "resolved-default",
  buildProvider: async () => ({
    id: "provider",
    supportsStructuredOutput: true,
    supportsVision: false,
    supportsReasoning: false,
    chat: async () => ({
      content: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [],
      }),
    }),
  }),
}));

function installChrome() {
  const store: Record<string, unknown> = {};
  const get = (keys: string | string[]) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const k of arr) if (k in store) result[k] = store[k];
    return Promise.resolve(result);
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get, set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
}

beforeEach(() => {
  h.userArgs = [];
  installChrome();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.resetModules();
});

function makeRequest(): AgentStepRequest {
  return {
    task: "test task",
    history: [],
    browserState: {
      url: "https://example.com",
      title: "Example",
      tabs: [],
      elementsText: "content",
      pageInfo: "",
      newElementCount: 0,
      screenshot: "SCREENSHOT",
    },
    step: 1,
    maxSteps: 10,
  };
}

describe("navigatorCallDirect — loop-warning forwarding", () => {
  test("forwards req.loopWarning into the navigator user message args", async () => {
    const { navigatorCallDirect } = await import("../src/extension/llm-direct");

    const warning =
      "<sys>LOOP DETECTED: you have taken an equivalent action 5 times in the recent window " +
      "without making progress. Try a DIFFERENT approach: scroll to find new elements, " +
      "switch strategy, or if truly stuck, call done(success=false) with an explanation.</sys>";
    const req = makeRequest();
    req.loopWarning = warning;

    await navigatorCallDirect(req);

    expect(h.userArgs).toHaveLength(1);
    const args = h.userArgs[0] as { loopWarning?: string };
    // The exact block must reach the message builder untouched.
    expect(args.loopWarning).toBe(warning);
  });

  test("leaves loopWarning undefined when the request carries none", async () => {
    const { navigatorCallDirect } = await import("../src/extension/llm-direct");

    await navigatorCallDirect(makeRequest());

    const args = h.userArgs[0] as { loopWarning?: string };
    expect(args.loopWarning).toBeUndefined();
  });
});
