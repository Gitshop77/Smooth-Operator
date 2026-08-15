import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildNavigatorUserMessage, buildPlannerUserMessage } from "../src/lib/agent/loop/messages";
import { buildNavigatorPrompt } from "../src/lib/agent/prompts/navigator-prompt";
import { buildPlannerPrompt } from "../src/lib/agent/prompts/planner-prompt";
import {
  compileJudgePromptV1,
  compileNavigatorPromptV1,
  compilePlannerPromptV1,
} from "../src/lib/agent/prompts/prompt-compiler";
import { buildJudgeUserMessage, JUDGE_SYSTEM_PROMPT } from "../src/lib/agent/prompts/judge-prompt";
import {
  decodePromptCacheDescriptorV1,
  PROMPT_CACHE_KEY_VERSION,
} from "../src/lib/agent/prompts/prompt-contract";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

beforeAll(() => installLocalStorageStub());
afterAll(() => restoreLocalStorageStub());

const navigatorUser: Parameters<typeof buildNavigatorUserMessage>[0] = {
  task: "Find the documented value",
  history: [],
  currentGoal: "Read the page",
  plan: ["Read", "Report"],
  currentPlanItem: 0,
  browserState: {
    url: "https://example.com/docs",
    title: "Documentation",
    tabs: [],
    elementsText: "[1]<button>Continue</button>",
    pageInfo: "0 pages above, 1 page below",
    newElementCount: 0,
    axTree: "button Continue",
  },
  step: 1,
  maxSteps: 10,
};

const plannerUser: Parameters<typeof buildPlannerUserMessage>[0] = {
  task: "Find the documented value",
  navigatorHistory: [],
  plan: ["Read", "Report"],
  currentPlanItem: 0,
  url: "https://example.com/docs",
  tabs: [],
  step: 1,
  maxSteps: 10,
};

describe("V1 prompt compiler byte identity", () => {
  test.each([
    { name: "default", customPrompt: undefined, visionMode: "disabled" as const, mode: "standard" },
    { name: "custom", customPrompt: "Use concise navigation.", visionMode: "disabled" as const, mode: "standard" },
    { name: "vision", customPrompt: undefined, visionMode: "always" as const, mode: "standard" },
    { name: "restricted mode", customPrompt: undefined, visionMode: "disabled" as const, mode: "restricted" },
  ])("preserves navigator system/user bytes for $name", async ({ customPrompt, visionMode, mode }) => {
    const systemSuffix = "\n\nFORMAT-SUFFIX";
    const userSuffix = "\n\nSCREENSHOT-SUFFIX";
    const expectedSystem = buildNavigatorPrompt(5, customPrompt, visionMode, mode) + systemSuffix;
    const expectedUser = await buildNavigatorUserMessage(navigatorUser) + userSuffix;

    const compiled = await compileNavigatorPromptV1({
      maxActions: 5,
      customPrompt,
      visionMode,
      mode,
      user: navigatorUser,
      systemSuffix,
      userSuffix,
    });

    expect(compiled.messages).toEqual([
      { role: "system", content: expectedSystem },
      { role: "user", content: expectedUser },
    ]);
  });

  test("preserves planner and judge bytes while caching only the repeated planner prefix", async () => {
    const plannerSuffix = "\n\nPLANNER-FORMAT";
    const planner = await compilePlannerPromptV1({
      customPrompt: "Plan tersely.",
      user: plannerUser,
      systemSuffix: plannerSuffix,
    });
    expect(planner.messages).toEqual([
      { role: "system", content: buildPlannerPrompt("Plan tersely.") + plannerSuffix },
      { role: "user", content: await buildPlannerUserMessage(plannerUser) },
    ]);
    expect(planner.cache).toMatchObject({
      cacheEligible: true,
      stableSectionIds: ["planner.system"],
      volatileSectionIds: ["planner.user"],
    });

    const judgeInput = {
      task: "Submit the form",
      history: [],
      agentResult: { success: true, text: "Submitted." },
    };
    const judge = await compileJudgePromptV1(judgeInput);
    expect(judge.messages).toEqual([
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildJudgeUserMessage(judgeInput) },
    ]);
    expect(judge.cache).toMatchObject({ cacheEligible: false, stableKey: null });
  });
});

describe("V1 prompt cache descriptor", () => {
  test("keeps the stable key across volatile page/user changes and invalidates on stable changes", async () => {
    const first = await compileNavigatorPromptV1({ maxActions: 5, user: navigatorUser });
    const pageChanged = await compileNavigatorPromptV1({
      maxActions: 5,
      user: {
        ...navigatorUser,
        task: "PAGE-SECRET-SENTINEL",
        browserState: { ...navigatorUser.browserState, elementsText: "PAGE-PLAINTEXT-SENTINEL" },
      },
    });
    const settingsChanged = await compileNavigatorPromptV1({
      maxActions: 5,
      customPrompt: "Changed stable settings prompt.",
      user: navigatorUser,
    });

    expect(first.cache).toMatchObject({
      cacheEligible: true,
      volatileBoundary: 1,
      stableSectionIds: ["navigator.system"],
      volatileSectionIds: ["navigator.user"],
    });
    expect(pageChanged.cache.stableKey).toBe(first.cache.stableKey);
    expect(settingsChanged.cache.stableKey).not.toBe(first.cache.stableKey);
    expect(JSON.stringify(pageChanged.cache)).not.toMatch(/PAGE-SECRET-SENTINEL|PAGE-PLAINTEXT-SENTINEL/);
  });

  test("uses the canonical length-framed SHA-256 stable-section key", async () => {
    const compiled = await compileNavigatorPromptV1({ maxActions: 5, user: navigatorUser });
    // The system message is always plain text (image parts attach only to the
    // navigator's user message), so narrow the widened content type.
    const systemContent = compiled.messages[0].content;
    const system = typeof systemContent === "string" ? systemContent : "";
    const id = "navigator.system";
    const encoder = new TextEncoder();
    const framed = `${PROMPT_CACHE_KEY_VERSION}\0${encoder.encode(id).byteLength}:${id}${encoder.encode(system).byteLength}:${system}`;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(framed).slice().buffer as ArrayBuffer);
    const expected = "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(compiled.cache.stableKey).toBe(expected);
  });

  test("strictly decodes only the exact V1 content-free descriptor shape", async () => {
    const descriptor = (await compileNavigatorPromptV1({ maxActions: 5, user: navigatorUser })).cache;
    expect(decodePromptCacheDescriptorV1(descriptor)).toEqual(descriptor);
    expect(decodePromptCacheDescriptorV1({ ...descriptor, version: 2 })).toBeNull();
    expect(decodePromptCacheDescriptorV1({ ...descriptor, plaintext: "must reject" })).toBeNull();
    expect(decodePromptCacheDescriptorV1({ ...descriptor, stableKey: "sha256:not-a-digest" })).toBeNull();
  });
});
