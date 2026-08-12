import { describe, expect, test, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { LogEvent } from "../src/lib/agent/types";

describe("agent-loop cancellation preflight", () => {
  test("a pre-aborted run starts no tab observation, provider, or tool work", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped before loop entry", "AbortError"));
    const events: LogEvent[] = [];
    const plannerCall = vi.fn(async () => ({ raw: "{}" }));
    const navigatorCall = vi.fn(async () => ({ raw: "{}" }));
    const getTabs = vi.fn(async () => []);
    const executeActions = vi.fn(async () => []);

    const deps: LoopDeps = {
      task: "must never start",
      signal: controller.signal,
      plannerCall,
      navigatorCall,
      getTabs,
      executeActions,
      onEvent: (event) => { events.push(event); },
      config: { maxSteps: 1 },
    };

    await runAgentLoop(deps);

    expect(getTabs).not.toHaveBeenCalled();
    expect(plannerCall).not.toHaveBeenCalled();
    expect(navigatorCall).not.toHaveBeenCalled();
    expect(executeActions).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "done")).toEqual([
      expect.objectContaining({ success: false, text: "Agent stopped by user." }),
    ]);
  });
});
