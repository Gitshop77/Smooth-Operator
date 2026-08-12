import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveAndValidateLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";
import { readErrorBodyPreview } from "../src/lib/agent/llm/route/transport-http-utils";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

const ABORT_DEADLINE_MS = 750;

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not stop promptly")), ABORT_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const savedChrome: { value: unknown } = { value: undefined };
afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = savedChrome.value;
  vi.restoreAllMocks();
});

describe("provider transport cancellation", () => {
  test("root abort interrupts a stalled SSRF DNS preflight and removes its listener", async () => {
    savedChrome.value = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { lastError: undefined },
      dns: { resolve: vi.fn() }, // deliberately never invokes its callback
    };
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = resolveAndValidateLlmBaseUrl(
      "https://provider.example/v1",
      false,
      undefined,
      { signal: controller.signal, dnsTimeoutMs: 5_000 },
    );

    controller.abort();
    await expect(settlesPromptly(pending)).rejects.toMatchObject({ name: "AbortError" });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("a stalled SSRF DNS preflight is bounded even without a root signal", async () => {
    savedChrome.value = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { lastError: undefined },
      dns: { resolve: vi.fn() }, // deliberately never invokes its callback
    };

    await expect(settlesPromptly(resolveAndValidateLlmBaseUrl(
      "https://provider.example/v1",
      false,
      undefined,
      { dnsTimeoutMs: 100 },
    ))).resolves.toMatchObject({ ok: false });
  });

  test("root abort interrupts a stalled non-2xx response preview", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const controller = new AbortController();
    const pending = readErrorBodyPreview({ body: stalled } as Response, controller.signal);

    controller.abort();
    await expect(settlesPromptly(pending)).rejects.toMatchObject({ name: "AbortError" });
  });
});

function loopDeps(
  signal: AbortSignal,
  overrides: Pick<LoopDeps, "detectChallenge" | "waitForChallengeResolution">,
  events: LogEvent[],
  extractState: NonNullable<LoopDeps["extractState"]>,
): LoopDeps {
  return {
    task: "stop during anti-bot work",
    signal,
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
    })),
    navigatorCall: vi.fn(async () => ({ raw: "{}" })),
    getTabs: vi.fn(async () => [{ id: 1, label: "1", url: "https://example.com", title: "Example", active: true }]),
    extractState,
    onEvent: (event) => { events.push(event); },
    config: { maxSteps: 1, enableLoopDetection: false },
    ...overrides,
  };
}

describe("anti-bot cancellation barrier", () => {
  test("abort during deferred challenge detection emits no challenge/resume and never re-observes", async () => {
    const controller = new AbortController();
    const events: LogEvent[] = [];
    const extractState = vi.fn(async () => makeState());
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const detectChallenge = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      started();
      return new Promise<null>(() => {});
    });
    const loop = runAgentLoop(loopDeps(controller.signal, { detectChallenge }, events, extractState));

    await startedPromise;
    controller.abort();
    await settlesPromptly(loop);

    expect(extractState).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "challenge_detected" || event.type === "resumed")).toBe(false);
  });

  test("abort during deferred challenge resolution prevents re-observation and resumed events", async () => {
    const controller = new AbortController();
    const events: LogEvent[] = [];
    const extractState = vi.fn(async () => makeState());
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const waitForChallengeResolution = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      started();
      return new Promise<boolean>(() => {});
    });
    const loop = runAgentLoop(loopDeps(
      controller.signal,
      { detectChallenge: vi.fn(async () => ({ kind: "cloudflare-js", message: "checking" })), waitForChallengeResolution },
      events,
      extractState,
    ));

    await startedPromise;
    controller.abort();
    await settlesPromptly(loop);

    expect(extractState).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "resumed")).toBe(false);
  });
});
