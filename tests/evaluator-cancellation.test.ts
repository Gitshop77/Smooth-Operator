import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type AgentConfig } from "../src/lib/agent/types";
import { runDeterministicEvaluators } from "../src/lib/agent/loop/helpers/evaluator-runner";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";

describe("deterministic evaluator cancellation", () => {
  test("passes the root signal to HTML extraction and rethrows cancellation", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const deps: Partial<LoopDeps> = {
      getPageHtml: (signal) => new Promise<string>((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    };
    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      expectedOutcomes: {
        html: [{ required_contents: { must_include: ["done"] } }],
      },
    };
    const state = { signal: controller.signal, lastObservedUrl: "https://example.test" } as LoopState;
    const pending = runDeterministicEvaluators(deps as LoopDeps, config, "done", state);
    controller.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).toBe(controller.signal);
  });

  test("does not turn an already-aborted evaluator into a failed score", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      expectedOutcomes: { string: [{ type: "must_include", ref: "done" }] },
    };
    await expect(runDeterministicEvaluators({} as LoopDeps, config, "done", {
      signal: controller.signal,
    } as LoopState)).rejects.toMatchObject({ name: "AbortError" });
  });
});
