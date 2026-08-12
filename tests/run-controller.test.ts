import { beforeEach, describe, expect, test } from "vitest";
import {
  RunController,
  beginRunController,
  canCurrentRunDispatch,
  getCurrentRunController,
  requestCurrentRunCancellation,
  resetRunControllerForTests,
} from "../src/extension/background/run-controller";

describe("authoritative RunController", () => {
  beforeEach(() => resetRunControllerForTests());

  test("cancellation is monotonic and invalidates every earlier dispatch token", () => {
    const controller = beginRunController({
      runId: "run-1",
      task: "hey",
      maxSteps: 10,
      mode: "standard",
      now: 100,
    });
    controller.markRunning(110);
    const token = controller.dispatchToken;
    expect(canCurrentRunDispatch(token)).toBe(true);

    const cancelled = requestCurrentRunCancellation("Stop requested", 120);
    expect(cancelled).toMatchObject({
      runId: "run-1",
      status: "cancelling",
      phase: "cancelling",
      dispatchRevision: token.dispatchRevision + 1,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(canCurrentRunDispatch(token)).toBe(false);

    const duplicate = controller.requestCancellation("later", 130);
    expect(duplicate.revision).toBe(cancelled?.revision);
    expect(duplicate.terminalMessage).toBe("Stop requested");
  });

  test("late terminal/progress callbacks cannot reopen a terminal run", () => {
    const controller = new RunController({
      runId: "run-1",
      task: "task",
      maxSteps: 5,
      mode: "restricted",
      now: 1,
    });
    controller.markRunning(2);
    const terminal = controller.markTerminal("succeeded", "Done", "answer", 3);
    const late = controller.updateProgress({ phase: "acting", step: 99 }, 4);
    expect(late).toEqual(terminal);
    expect(late).toMatchObject({
      status: "succeeded",
      phase: "terminal",
      step: 0,
      resultText: "answer",
    });
  });

  test("the snapshot records the validated runtime mode and step cap", () => {
    const controller = new RunController({
      runId: "run-config",
      task: "task",
      maxSteps: 500,
      mode: "full_agentic",
      now: 1,
    });
    const reconciled = controller.updateConfiguration(
      { maxSteps: 30, mode: "restricted" },
      2,
    );
    expect(reconciled).toMatchObject({
      maxSteps: 30,
      mode: "restricted",
      revision: 2,
      status: "starting",
      updatedAt: 2,
    });
  });

  test("a new run may replace only a terminal controller", () => {
    beginRunController({ runId: "a", task: "a", maxSteps: 1, mode: "standard", now: 1 });
    expect(() =>
      beginRunController({ runId: "b", task: "b", maxSteps: 1, mode: "standard", now: 2 }),
    ).toThrow("already active");
    getCurrentRunController()?.markTerminal("failed", "failed", undefined, 3);
    expect(
      beginRunController({ runId: "b", task: "b", maxSteps: 1, mode: "standard", now: 4 }).snapshot.runId,
    ).toBe("b");
  });

  test("Stop reports idle after the authoritative run is already terminal", () => {
    const controller = beginRunController({
      runId: "done",
      task: "done",
      maxSteps: 1,
      mode: "standard",
      now: 1,
    });
    controller.markTerminal("succeeded", "Done", "Done", 2);
    expect(requestCurrentRunCancellation("too late", 3)).toBeNull();
    expect(controller.snapshot.status).toBe("succeeded");
  });
});
