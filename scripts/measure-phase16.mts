/**
 * Phase 16 — measured baselines (offline, deterministic).
 *
 * Measures, WITHOUT any network or browser:
 *  1. Provider-construction latency (`buildProvider`) per provider family.
 *  2. Prompt-compile latency per family (navigator / planner / judge),
 *     including the SHA-256 cache descriptor.
 *  3. Compiled-prompt byte sizes across a representative corpus + headroom
 *     versus the Phase 8 budget profiles (per-family max-input tokens).
 *  4. Fast-path classifier stats over a task corpus + the compiled planner
 *     prompt bytes a matching task avoids (the LLM cost the fast path saves).
 *  5. Loop hot-path costs: full navigator-message build (redaction +
 *     injection scan + render) with warm vs cold redaction caches, and
 *     key-shape redaction throughput.
 *
 * Run: `npx tsx scripts/measure-phase16.ts`
 * Output: printed table + JSON evidence written to
 *         docs/redesign/phase16-measurements.json (overwritten each run).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildProvider } from "../src/extension/provider-config";
import {
  compileJudgePromptV1,
  compileNavigatorPromptV1,
  compilePlannerPromptV1,
} from "../src/lib/agent/prompts/prompt-compiler";
import { PROMPT_BUDGET_PROFILES_V1, utf8ByteLength } from "../src/lib/agent/prompts/prompt-token-budget";
import { buildNavigatorUserMessage } from "../src/lib/agent/loop/messages";
import { redactKeyShapes } from "../src/lib/agent/key-shape-redact";
import { classifyCurrentPageTask } from "../src/lib/agent/loop/phases/fast-path";
import type { ActionResult, HistoryItem } from "../src/lib/agent/types";

// ─── Statistics ──────────────────────────────────────────────────────────────

interface Stats {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    meanMs: mean,
    medianMs: median,
    p95Ms: p95,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    samples: samples.length,
  };
}

async function measure<T>(fn: () => Promise<T>, warmup = 3, iterations = 100): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}

function fmt(stats: Stats): string {
  return `mean ${stats.meanMs.toFixed(3)}ms  median ${stats.medianMs.toFixed(3)}ms  p95 ${stats.p95Ms.toFixed(3)}ms  (${stats.samples} samples)`;
}

// ─── Corpus fixtures ─────────────────────────────────────────────────────────

function makeHistoryItem(step: number, extra?: Partial<HistoryItem>): HistoryItem {
  return {
    step,
    agent: "navigator",
    evaluation: `Previous goal ${step} achieved: found the relevant section.`,
    memory: `Completed step ${step}; next up is verifying the extracted value.`,
    goal: `Read and verify the target value on step ${step}.`,
    results: [
      {
        action: { type: "scroll", down: true, pages: 1 },
        success: true,
        message: "Scrolled to reveal content.",
        pageChanged: true,
      } as ActionResult,
      {
        action: { type: "extract", query: `Find the value on step ${step}` },
        success: true,
        message: "Extracted the target text.",
        extractedContent: `Extracted value for step ${step}: the documented amount is 1,234 units.`,
      } as ActionResult,
    ],
    ...extra,
  };
}

function makeTab(id: number, url: string, title: string) {
  return { id, label: String(id), url, title };
}

const SMALL_TABS = [makeTab(1, "https://docs.example.com/", "Docs")];
const MANY_TABS = Array.from({ length: 15 }, (_, i) =>
  makeTab(i + 1, `https://app.example.com/project/${i + 1}`, `Project ${i + 1} dashboard`),
);


/** The corpus: each entry is a realistic compile input for one prompt family. */
const CORPUS: Array<{
  id: string;
  family: "navigator" | "planner" | "judge";
  label: string;
  input: unknown;
}> = [
  {
    id: "navigator.small",
    family: "navigator",
    label: "small page, 0 history, 1 tab",
    input: {
      maxActions: 8,
      visionMode: "disabled",
      mode: "standard",
      user: {
        task: "What is the current URL of this documentation site?",
        history: [],
        currentGoal: "Read the documentation URL.",
        plan: ["Read", "Report"],
        currentPlanItem: 0,
        browserState: {
          url: "https://docs.example.com/",
          title: "Example Documentation",
          tabs: SMALL_TABS,
          elementsText: "[1]<button>Continue</button>\n[2]<a href=\"/start\">Get started</a>",
          pageInfo: "0 pages above, 1 page below",
          newElementCount: 0,
          axTree: "heading Documentation\nlink Get started",
        },
        step: 1,
        maxSteps: 10,
      },
    },
  },
  {
    id: "navigator.medium",
    family: "navigator",
    label: "medium page, 12-step history, 15 tabs",
    input: {
      maxActions: 8,
      visionMode: "disabled",
      mode: "standard",
      user: {
        task: "Fill the contact form and submit it.",
        history: Array.from({ length: 12 }, (_, i) => makeHistoryItem(i)),
        currentGoal: "Locate the contact form fields.",
        plan: ["Locate form", "Fill fields", "Submit"],
        currentPlanItem: 1,
        browserState: {
          url: "https://app.example.com/contact",
          title: "Contact — Example App",
          tabs: MANY_TABS,
          elementsText: Array.from({ length: 400 }, (_, i) =>
            `[${i + 1}]<input placeholder="Field ${i}" name="field_${i}" />`).join("\n"),
          pageInfo: "1 pages above, 3 pages below",
          newElementCount: 3,
          axTree: Array.from({ length: 200 }, (_, i) => `textbox Field ${i}`).join("\n"),
        },
        step: 4,
        maxSteps: 20,
      },
    },
  },
  {
    id: "navigator.large",
    family: "navigator",
    label: "large page (60k char cap), 12-step history, 15 tabs",
    input: {
      maxActions: 8,
      visionMode: "disabled",
      mode: "standard",
      user: {
        task: "Read the pricing table and report the enterprise tier price.",
        history: Array.from({ length: 12 }, (_, i) => makeHistoryItem(i)),
        currentGoal: "Locate the pricing table.",
        plan: ["Locate pricing", "Read table", "Report"],
        currentPlanItem: 0,
        browserState: {
          url: "https://app.example.com/pricing",
          title: "Pricing — Example App",
          tabs: MANY_TABS,
          // 80k chars of rendered page text: hits the 60k ELEMENTS_TEXT_CHAR_CAP
          // inside the message builder (realistic steady-state for a long page).
          elementsText: Array.from({ length: 4_000 }, (_, i) =>
            `[${i + 1}]<div>Line of page content ${i} with some meaningful words repeated over and over.</div>`).join("\n"),
          pageInfo: "0 pages above, 6 pages below",
          newElementCount: 0,
          axTree: Array.from({ length: 800 }, (_, i) => `row Pricing row ${i}`).join("\n"),
        },
        step: 3,
        maxSteps: 20,
      },
    },
  },
  {
    id: "navigator.custom",
    family: "navigator",
    label: "custom prompt + vision always + restricted mode",
    input: {
      maxActions: 5,
      customPrompt: "Navigate tersely. Prefer keyboard shortcuts. Never click links that look like ads.",
      visionMode: "always",
      mode: "restricted",
      user: {
        task: "What is the title of the current page?",
        history: [],
        currentGoal: "Answer from the page title.",
        plan: ["Read", "Report"],
        currentPlanItem: 0,
        browserState: {
          url: "https://example.com/",
          title: "Example Domain",
          tabs: SMALL_TABS,
          elementsText: "[1]<p>Example Domain</p>",
          pageInfo: "0 pages above, 0 pages below",
          newElementCount: 0,
        },
        step: 0,
        maxSteps: 5,
      },
    },
  },
  {
    id: "planner.fresh",
    family: "planner",
    label: "planner, fresh run (no history)",
    input: {
      customPrompt: undefined,
      user: {
        task: "Sign up for the newsletter and confirm the confirmation message.",
        navigatorHistory: [],
        plan: ["Open signup", "Submit email", "Confirm"],
        currentPlanItem: 0,
        url: "https://example.com/",
        tabs: SMALL_TABS,
        step: 0,
        maxSteps: 10,
      },
    },
  },
  {
    id: "planner.withHistory",
    family: "planner",
    label: "planner, 8-step history, 15 tabs",
    input: {
      customPrompt: undefined,
      user: {
        task: "Sign up for the newsletter and confirm the confirmation message.",
        navigatorHistory: Array.from({ length: 8 }, (_, i) => makeHistoryItem(i)),
        plan: ["Open signup", "Submit email", "Confirm"],
        currentPlanItem: 1,
        url: "https://example.com/newsletter",
        tabs: MANY_TABS,
        step: 2,
        maxSteps: 10,
      },
    },
  },
  {
    id: "judge.success",
    family: "judge",
    label: "judge, successful completion",
    input: {
      task: "Report the enterprise tier price.",
      history: Array.from({ length: 6 }, (_, i) => makeHistoryItem(i)),
      agentResult: { success: true, text: "The enterprise tier is $1,234 per month." },
    },
  },
  {
    id: "judge.ambiguous",
    family: "judge",
    label: "judge, ambiguous completion",
    input: {
      task: "Book the earliest available flight.",
      history: Array.from({ length: 10 }, (_, i) => makeHistoryItem(i)),
      agentResult: {
        success: true,
        text: "I found several flights but could not determine which is earliest.",
      },
    },
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

const evidence: Record<string, unknown> = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  providerConstruction: {},
  promptCompile: {},
  corpusBytes: {},
  fastPath: {},
  hotPath: {},
};

const rows: string[] = [];
const log = (s: string) => {
  rows.push(s);
};

log("=== Phase 16 measured baselines (offline) ===");

// 1. Provider construction.
log("\n--- 1. Provider construction (buildProvider) ---");
const providerCases: Array<{ id: string; config: Parameters<typeof buildProvider>[0] }> = [
  { id: "openai", config: { provider: "openai", apiKey: "sk-benchmark-key-not-real", model: "gpt-4o" } },
  { id: "anthropic", config: { provider: "anthropic", apiKey: "sk-ant-benchmark-key-not-real", model: "claude-sonnet-5" } },
  { id: "gemini", config: { provider: "gemini", apiKey: "AIzaBenchmarkKeyNotReal000000000000000000", model: "gemini-2.5-flash" } },
  { id: "openai-compatible.deepseek", config: { provider: "deepseek", apiKey: "sk-benchmark-key-not-real", model: "deepseek-chat" } },
];
for (const c of providerCases) {
  const stats = await measure(() => buildProvider(c.config), 2, 100);
  evidence.providerConstruction[c.id] = stats;
  log(`  ${c.id.padEnd(30)} ${fmt(stats)}`);
}

// 2. Prompt-compile latency.
log("\n--- 2. Prompt-compile latency (V1 compiler incl. SHA-256 descriptor) ---");
const compileLatency: Array<{ id: string; run: () => Promise<unknown> }> = [
  {
    id: "navigator",
    run: () => compileNavigatorPromptV1(CORPUS[0].input as Parameters<typeof compileNavigatorPromptV1>[0]),
  },
  {
    id: "navigator.large",
    run: () => compileNavigatorPromptV1(CORPUS[2].input as Parameters<typeof compileNavigatorPromptV1>[0]),
  },
  {
    id: "planner",
    run: () => compilePlannerPromptV1(CORPUS[4].input as Parameters<typeof compilePlannerPromptV1>[0]),
  },
  {
    id: "judge",
    run: () => compileJudgePromptV1(CORPUS[6].input as Parameters<typeof compileJudgePromptV1>[0]),
  },
];
for (const c of compileLatency) {
  const stats = await measure(c.run, 3, 200);
  evidence.promptCompile[c.id] = stats;
  log(`  ${c.id.padEnd(20)} ${fmt(stats)}`);
}

// 3. Compiled-prompt bytes across the corpus + budget headroom.
log("\n--- 3. Compiled-prompt bytes (UTF-8) + budget headroom ---");
for (const entry of CORPUS) {
  let compiled: { messages: ReadonlyArray<{ content: string }> };
  if (entry.family === "navigator") {
    compiled = await compileNavigatorPromptV1(entry.input as Parameters<typeof compileNavigatorPromptV1>[0]);
  } else if (entry.family === "planner") {
    compiled = await compilePlannerPromptV1(entry.input as Parameters<typeof compilePlannerPromptV1>[0]);
  } else {
    compiled = await compileJudgePromptV1(entry.input as Parameters<typeof compileJudgePromptV1>[0]);
  }
  const systemBytes = utf8ByteLength(compiled.messages[0]?.content ?? "");
  const userBytes = utf8ByteLength(compiled.messages[1]?.content ?? "");
  const totalBytes = utf8ByteLength(compiled.messages.map((m) => m.content).join("\n"));
  const profile = PROMPT_BUDGET_PROFILES_V1[entry.family];
  const headroomPct = (1 - totalBytes / profile.maxInputTokens) * 100;
  evidence.corpusBytes[entry.id] = {
    family: entry.family,
    systemBytes,
    userBytes,
    totalBytes,
    maxInputTokens: profile.maxInputTokens,
    headroomPct,
  };
  log(
    `  ${entry.id.padEnd(22)} ${entry.label.padEnd(46)} sys ${String(systemBytes).padStart(8)}  user ${String(userBytes).padStart(8)}  total ${String(totalBytes).padStart(8)}  max ${String(profile.maxInputTokens).padStart(7)}  headroom ${headroomPct.toFixed(2)}%`,
  );
}



// 4. Fast-path: classifier stats + the planner cost a matching task avoids.
log("\n--- 4. Fast-path decision evidence ---");
const FAST_PATH_CORPUS = [
  "what is the title of this page",
  "what is the title of the current tab?",
  "what's the current page title",
  "what is this document's title",
  "page title",
  "what is the url of this page",
  "what's the current url",
  "what is this tab's address",
  "current url",
  "what page am i on",
  "which page is this",
  "what is the title of this page, then click the button",
  "add item to cart",
  "what is this page about",
  "what is the weather",
  "what is the title of the best page on the web",
  "scroll to the bottom of the page",
  "summarize this page",
];
let matched = 0;
const classifierResults: Array<{ task: string; kind: string | null }> = [];
for (const task of FAST_PATH_CORPUS) {
  const kind = classifyCurrentPageTask(task);
  if (kind) matched++;
  classifierResults.push({ task, kind });
}
log(
  `  classifier corpus: ${FAST_PATH_CORPUS.length} tasks, ${matched} fast-path matches (${((matched / FAST_PATH_CORPUS.length) * 100).toFixed(1)}%)`,
);
log("  match precision: 1.0 by construction (patterns are anchored exact matches)");

// The planner prompt the fast path AVOIDS for a matching task: same inputs the
// orchestrator would send, compiled to bytes.
const avoidedBytes: Record<string, number> = {};
for (const task of ["what is the title of this page", "what is the current url", "what page am i on"]) {
  const compiled = await compilePlannerPromptV1({
    user: {
      task,
      navigatorHistory: [],
      plan: undefined,
      currentPlanItem: undefined,
      url: "https://docs.example.com/",
      tabs: SMALL_TABS,
      step: 0,
      maxSteps: 10,
    },
  });
  const total = utf8ByteLength(compiled.messages.map((m) => m.content).join("\n"));
  avoidedBytes[task] = total;
  log(`  planner prompt bytes AVOIDED for "${task}": ${total} bytes`);
}
// The judge call is also skipped on the fast path (completion-with-evidence
// rule) — its bytes are the second saving.
const judgeCompiled = await compileJudgePromptV1({
  task: "what is the title of this page",
  history: [],
  agentResult: { success: true, text: 'The title of this page is "Open Cowork Docs".' },
});
const judgeBytes = utf8ByteLength(judgeCompiled.messages.map((m) => m.content).join("\n"));
log(`  judge prompt bytes AVOIDED per fast-path completion: ${judgeBytes} bytes`);
evidence.fastPath = {
  corpusSize: FAST_PATH_CORPUS.length,
  matches: matched,
  matchRatePct: (matched / FAST_PATH_CORPUS.length) * 100,
  classifierResults,
  plannerBytesAvoided: avoidedBytes,
  judgeBytesAvoidedPerCompletion: judgeBytes,
};


// 5. Loop hot path: navigator message build (redaction + injection scan + render).
log("\n--- 5. Loop hot path (buildNavigatorUserMessage) ---");
const history12 = Array.from({ length: 12 }, (_, i) => makeHistoryItem(i));
const history30 = Array.from({ length: 30 }, (_, i) => makeHistoryItem(i));
const baseBrowserState = {
  url: "https://app.example.com/contact",
  title: "Contact — Example App",
  tabs: MANY_TABS,
  elementsText: Array.from({ length: 1_000 }, (_, i) => `[${i + 1}]<input placeholder="Field ${i}" />`).join("\n"),
  pageInfo: "1 pages above, 3 pages below",
  newElementCount: 3,
  axTree: Array.from({ length: 500 }, (_, i) => `textbox Field ${i}`).join("\n"),
};

const hotCases: Array<{ id: string; history: HistoryItem[]; label: string }> = [
  { id: "navigatorMsg.step1", history: [], label: "step 1, no history" },
  { id: "navigatorMsg.step5.cold", history: history12.slice(0, 5), label: "step 5, cold redaction cache" },
  { id: "navigatorMsg.step12.warm", history: history12, label: "step 12, warm redaction cache" },
  { id: "navigatorMsg.step30.warm", history: history30, label: "step 30, warm redaction cache" },
];
for (const c of hotCases) {
  const arg = {
    task: "Fill the contact form and submit it.",
    history: c.history,
    currentGoal: "Locate the contact form fields.",
    plan: ["Locate form", "Fill fields", "Submit"],
    currentPlanItem: 1,
    browserState: baseBrowserState,
    step: c.history.length,
    maxSteps: 30,
  } as Parameters<typeof buildNavigatorUserMessage>[0];
  const stats = await measure(() => buildNavigatorUserMessage(arg), 2, 50);
  evidence.hotPath[c.id] = stats;
  log(`  ${c.id.padEnd(28)} ${fmt(stats)}`);
}

// Key-shape redaction throughput on large page text (the pure hot primitive).
log("\n--- 5b. redactKeyShapes throughput ---");
const bigPage = Array.from({ length: 20_000 }, (_, i) =>
  `some page text line ${i} with a sk-ABCDEFGHIJKLMNOPQRST secret marker and normal words`,
).join("\n");
const ksStats = await measure(() => Promise.resolve(redactKeyShapes(bigPage)), 2, 50);
evidence.hotPath.redactKeyShapes20kLines = { ...ksStats, inputBytes: utf8ByteLength(bigPage) };
log(`  ${"redactKeyShapes 20k lines".padEnd(28)} ${fmt(ksStats)} (input ${utf8ByteLength(bigPage)} bytes)`);

// ─── Emit evidence file ───────────────────────────────────────────────────────

const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/redesign/phase16-measurements.json");
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
log(`\nEvidence written to docs/redesign/phase16-measurements.json`);
process.stdout.write(rows.join("\n") + "\n");
