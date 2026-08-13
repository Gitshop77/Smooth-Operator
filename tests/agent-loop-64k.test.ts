
/** Byte length of a tagged section within a rendered message (or 0 if absent). */
function sectionBytes(text: string, openTag: string): number {
  const start = text.indexOf(openTag);
  if (start === -1) return 0;
  const close = text.indexOf("</", start + openTag.length);
  return close === -1 ? text.length - start : close - start;
}

/**
 * 64k-context loop survival — the acceptance milestone the harness must PROVE.
 *
 * Drives the REAL `runAgentLoop` with a 64k `config.contextTokens` on a LARGE



 * page (a 64k-char elementsText + 63k-char AX tree — far beyond what a 64k
 * model can fit) and asserts, for every navigator step:
 *  1. The observation was DEGRADED by the context-derived caps
 *     (`deriveNavigatorObservationCapsV1`), not shipped whole.
 *  2. The compiled navigator prompt FITS the 64k-model derived input budget
 *     (the mock replicates the production llm-direct compile+assert boundary
 *     — a budget failure throws here and fails the test).
 *  3. The run progresses past 20 browser steps (the milestone) and prompt
 *     sizes stay bounded (no unbounded growth).
 *
 * The second test adds compaction into the mix: history grows past the 30k
 * compaction threshold mid-run, compaction runs, and the run continues —
 * proving auto-compaction does not break a 64k run.
 */
import { describe, expect, test, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { compileNavigatorPromptV1 } from "../src/lib/agent/prompts/prompt-compiler";
import {
  deriveNavigatorObservationCapsV1,
  assertCompiledPromptWithinContextBudgetV1,
  utf8ByteLength,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { makeState } from "./helpers";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, ActionResult, LogEvent } from "../src/lib/agent/types";

const CONTEXT = 64_000;
const MAX_STEPS = 22;
const caps = deriveNavigatorObservationCapsV1(CONTEXT);

const RESULT: ActionResult = {
  action: { type: "click" as const, index: 1 },
  success: true,
  message: "Clicked the element successfully. ",
  extractedContent: "Enterprise plan: $9,999/year for 100 seats, 20% annual discount for billing.",
};

const NAVIGATOR_JSON = (step: number): string => JSON.stringify({
  thinking: "x",
  evaluation_previous_goal: "ok",
  memory: "on step " + step,
  next_goal: "read pricing",
  action: [{ type: "click", index: 1 }],
});

function buildDeps(opts: {
  enableCompaction: boolean;
  maxSteps?: number;
  onEvent: (e: LogEvent) => void;
}): {
  deps: LoopDeps;
  promptSizes: number[];
  plannerSizes: number[];
  navigatorCalls: AgentStepRequest[];
} {
  const promptSizes: number[] = [];
  const plannerSizes: number[] = [];
  const navigatorCalls: AgentStepRequest[] = [];
  const deps: LoopDeps = {
    task: "Find the enterprise pricing plan and report the annual cost including discounts.",
    // Near-zero settle delay keeps the 22-step simulation fast in CI.
    config: {
      maxSteps: opts.maxSteps ?? MAX_STEPS,
      maxActionsPerStep: 10,
      plannerInterval: 100,
      maxFailures: 5,
      costCapUsd: 0,
      enableLoopDetection: true,
      enableCompaction: opts.enableCompaction,
      compactionStepInterval: 3,
      compactionCharThreshold: 5_000,
      enableJudge: false,
      enableEarlyStop: false,
      enableHtmlSummarizer: false, // exercise the CAPS path, not the summarizer
      enableFastPath: false,
      contextTokens: CONTEXT,
    },
    getTabs: vi.fn(async () => [
      { id: 1, label: "1", url: "https://example.com/pricing", title: "Pricing", active: true },
    ]),
    settleDelay: 1,
    // A LARGE page: 64k chars of interactive elements + 63k chars of AX tree.
    extractState: vi.fn(async () => makeState({
      url: "https://example.com/pricing",
      title: "Pricing",
      elementsText: "[1]<button>Compare plans</button>\n".repeat(2000),
      axTree: "button Compare plans\n".repeat(3000),
      pageInfo: "",
    })),
    executeActions: vi.fn(async (actions: AgentStepRequest["history"][number]["results"][number]["action"][]) =>
      actions.map((action) => ({ ...RESULT, action }))),
    onEvent: opts.onEvent,
    plannerCall: vi.fn(async (req) => {
      // Replicate the production llm-direct planner compile+assert boundary
      // (planner derived budget for 64k = 64k − 8k output − 8k reasoning).
      const { buildPlannerUserMessage } = await import("../src/lib/agent/loop/messages");
      const userMsg = await buildPlannerUserMessage({
        task: req.task,
        navigatorHistory: req.history ?? [],
        plan: req.plan,
        currentPlanItem: req.currentPlanItem,
        url: req.url,
        tabs: req.tabs,
        step: req.step,
        maxSteps: req.maxSteps,
        compactedMemory: req.compactedMemory,
      });
      const { buildPlannerPrompt } = await import("../src/lib/agent/prompts/planner-prompt");
      const system = buildPlannerPrompt(undefined);
      const bytes = utf8ByteLength(system + "\n" + userMsg);
      plannerSizes.push(bytes);
      expect(bytes).toBeLessThanOrEqual(64_000 - 8_192 - 8_192);
      return {
        raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a", "b", "c"], next_goal: "g" }),
      };
    }),
    summarizeCall: vi.fn(async () => ({ content: "Prior steps summary: clicked and extracted pricing. (test)" })),
    navigatorCall: vi.fn(async (req: AgentStepRequest) => {
      navigatorCalls.push(req);
      // Replicate the production llm-direct compile+assert boundary: if the
      // assembled prompt exceeds the 64k-derived budget, the assert throws and
      // the test fails — this is the survival proof.
      const compiled = await compileNavigatorPromptV1({
        maxActions: 5,
        // llm-direct uses the COMPACT system prompt for <128k models — replicate.
        compact: true,
        user: {
          task: req.task,
          history: req.history,
          currentGoal: req.currentGoal ?? "",
          plan: req.plan,
          currentPlanItem: req.currentPlanItem ?? 0,
          browserState: req.browserState,
          step: req.step,
          maxSteps: req.maxSteps,
          compactedMemory: req.compactedMemory,
        },
      });
      promptSizes.push(utf8ByteLength(compiled.messages[0].content + "\n" + compiled.messages[1].content));
      assertCompiledPromptWithinContextBudgetV1("navigator", "navigator-64k", compiled.messages, CONTEXT);
      return { raw: NAVIGATOR_JSON(req.step) };
    }),
  };
  return { deps, promptSizes, plannerSizes, navigatorCalls };
}

describe("64k-context loop survival", () => {
  test("20+ browser steps on a large page, every navigator prompt within the 64k budget", async () => {
    const events: LogEvent[] = [];
    const { deps, promptSizes, navigatorCalls } = buildDeps({ enableCompaction: false, onEvent: (e) => events.push(e) });

    await runAgentLoop(deps);

    // The run actually progressed past the 20-step milestone.
    // The run actually progressed past the 20-step milestone (the mock
    // executeActions override does not emit action-result events — the
    // extension's override emits those itself — so count navigator calls).
    const navigatorSteps = (deps.navigatorCall as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(navigatorSteps).toBeGreaterThanOrEqual(20);

    // Every navigator step compiled a prompt that FITS the 64k budget (the
    // assert inside the mock threw otherwise).
    expect(promptSizes.length).toBeGreaterThanOrEqual(20);
    for (const bytes of promptSizes) {
      expect(bytes).toBeLessThanOrEqual(39_424);
    }

    // The big-page observation was DEGRADED by the caps, not shipped whole.
    const first = navigatorCalls[0];
    expect(first.browserState.elementsText.length).toBeLessThanOrEqual(caps.elementsTextChars);
    expect((first.browserState.axTree ?? "").length).toBeLessThanOrEqual(caps.axTreeChars);

    // Prompt sizes stayed bounded across the run (no unbounded growth).
    expect(Math.max(...promptSizes) - Math.min(...promptSizes)).toBeLessThan(8_000);
  });

  test("auto-compaction runs mid-run and the 64k run continues with bounded prompts", async () => {
    const events: LogEvent[] = [];
    const { deps, promptSizes } = buildDeps({ enableCompaction: true, onEvent: (e) => events.push(e) });

    await runAgentLoop(deps);

    // Compaction actually ran (history crosses the threshold mid-run).
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);

    const navigatorSteps = (deps.navigatorCall as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(navigatorSteps).toBeGreaterThanOrEqual(20);
    for (const bytes of promptSizes) {
      expect(bytes).toBeLessThanOrEqual(39_424);
    }
    // The run continued AFTER compaction (navigator calls beyond the
    // compaction point exist) — compaction did not break the run.
    expect(promptSizes.length).toBe(navigatorSteps);
  });

  test("50+ steps with REPEATED compactions: every prompt fits, compacted memory is retained", async () => {
    const events: LogEvent[] = [];
    const { deps, promptSizes, plannerSizes, navigatorCalls } = buildDeps({
      enableCompaction: true,
      maxSteps: 50,
      onEvent: (e) => events.push(e),
    });

    await runAgentLoop(deps);

    // Repeated compaction: history crosses the threshold several times over
    // 50 steps (interval 3, threshold 5k chars — realistic per-step results).
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(2);

    // The run progressed past 50 browser steps.
    const navigatorSteps = (deps.navigatorCall as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(navigatorSteps).toBeGreaterThanOrEqual(50);

    // Every navigator prompt fits the 64k derived input budget; every planner
    // prompt fits the planner derived budget.
    expect(promptSizes.length).toBe(navigatorSteps);
    for (const bytes of promptSizes) {
      expect(bytes).toBeLessThanOrEqual(39_424);
    }
    expect(plannerSizes.length).toBeGreaterThan(0);
    for (const bytes of plannerSizes) {
      expect(bytes).toBeLessThanOrEqual(64_000 - 8_192 - 8_192);
    }

    // Prompt sizes stay bounded across the whole run (no unbounded growth /
    // context drift across repeated compactions).
    expect(Math.max(...promptSizes) - Math.min(...promptSizes)).toBeLessThan(10_000);

    // Compacted memory is RETAINED after compaction: navigator requests after
    // the first compaction carry the summarized <compacted_memory> block, so
    // the agent continues with prior context instead of going brain-dead.
    const firstCompactionStep = compactions[0].step as number;
    const postCompactionCalls = navigatorCalls.filter((c) => c.step > firstCompactionStep);
    expect(postCompactionCalls.length).toBeGreaterThan(0);
    expect(
      postCompactionCalls.some((c) => !!c.compactedMemory && c.compactedMemory.length > 0),
    ).toBe(true);
  });

  test("per-turn input accounting: every component is bounded across 20 steps", async () => {
    const events: LogEvent[] = [];
    const { deps } = buildDeps({ enableCompaction: false, onEvent: (e) => events.push(e) });
    const { buildNavigatorUserMessage } = await import("../src/lib/agent/loop/messages");
    const { buildNavigatorPrompt } = await import("../src/lib/agent/prompts/navigator-prompt");

    // llm-direct uses the COMPACT system prompt for <128k models.
    const systemBytes = utf8ByteLength(buildNavigatorPrompt(5, undefined, "disabled", "standard", true));
    const profile: Array<Record<string, number>> = [];
    const mock = deps.navigatorCall as ReturnType<typeof vi.fn>;
    const original = mock.getMockImplementation() as ((req: AgentStepRequest) => Promise<unknown>) | undefined;
    mock.mockImplementation(async (req: AgentStepRequest) => {
      const userMsg = await buildNavigatorUserMessage({
        task: req.task,
        currentGoal: req.currentGoal ?? "",
        plan: req.plan,
        currentPlanItem: req.currentPlanItem ?? 0,
        history: req.history,
        browserState: req.browserState,
        step: req.step,
        maxSteps: req.maxSteps,
        compactedMemory: req.compactedMemory,
      });
      const userBytes = utf8ByteLength(userMsg);
      const taskGoal = sectionBytes(userMsg, "<current_goal>");
      const history = sectionBytes(userMsg, "<agent_history>");
      const obs = sectionBytes(userMsg, "<browser_state>") + sectionBytes(userMsg, "<accessibility_tree>");
      profile.push({ system: systemBytes, taskGoal, history, obs, user: userBytes, total: systemBytes + userBytes });
      return original!(req);
    });

    await runAgentLoop(deps);
    expect(profile.length).toBeGreaterThanOrEqual(20);

    // Documented per-turn input map for the milestone turns — each must fit the
    // 64k derived input budget (39,424 bytes).
    for (const turn of [0, 4, 9, 14, 19]) {
      expect(profile[turn].total).toBeLessThanOrEqual(39_424);
    }

    // History stays bounded (stale-observation masking): the <agent_history>
    // section plateaus once the render window is full instead of growing
    // linearly with steps.
    expect(profile[19].history).toBeLessThan(profile[0].history * 3);

    // The observation is bounded by the context-derived caps (elements cap
    // 2,910 + AX cap 514 for 64k), not shipped whole from the 64k-char page.
    expect(profile[0].obs).toBeLessThan(caps.elementsTextChars + caps.axTreeChars + 200);
  });

  test("100+ steps: sustained coherence across ~5 compactions with bounded prompts", async () => {
    const events: LogEvent[] = [];
    const { deps, promptSizes, navigatorCalls } = buildDeps({
      enableCompaction: true,
      maxSteps: 100,
      onEvent: (e) => events.push(e),
    });

    await runAgentLoop(deps);

    // 100+ browser steps completed.
    const navigatorSteps = (deps.navigatorCall as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(navigatorSteps).toBeGreaterThanOrEqual(100);

    // ~5 compactions across 100 steps (threshold 5k, interval 3).
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(4);

    // EVERY navigator prompt across all 100 steps fits the 64k budget.
    expect(promptSizes.length).toBe(navigatorSteps);
    for (const bytes of promptSizes) {
      expect(bytes).toBeLessThanOrEqual(39_424);
    }

    // No context drift: the final prompt is not meaningfully larger than the
    // plateau at step 20 (bounded by architecture, not by luck).
    expect(promptSizes[promptSizes.length - 1]).toBeLessThan(promptSizes[19] + 5_000);

    // Compacted memory retained in late prompts (post-compaction continuity).
    const lastCompactionStep = compactions[compactions.length - 1].step as number;
    const lateCalls = navigatorCalls.filter((c) => c.step > lastCompactionStep);
    expect(lateCalls.some((c) => !!c.compactedMemory && c.compactedMemory.length > 0)).toBe(true);
  });
});
