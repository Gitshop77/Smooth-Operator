import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RunBuilder, saveRun } from "../src/lib/agent/run-history";
import {
  primeLiveSecretRedaction,
  resetLiveSecretRedactionForTests,
  deleteSecret,
  setSecret,
} from "../src/lib/agent/secrets";
import { RunController } from "../src/extension/background/run-controller";
import {
  projectRunEvent,
  redactLiveRunEvent,
  redactLiveRunSnapshot,
} from "../src/extension/background/run-event-projection";
import {
  LAST_RUN_SNAPSHOT_KEY,
  persistRunSnapshot,
  resetRunSnapshotWriteChainForTests,
} from "../src/extension/background/run-snapshot-store";

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = {};

beforeEach(async () => {
  for (const value of [session, local]) {
    for (const key of Object.keys(value)) delete value[key];
  }
  resetLiveSecretRedactionForTests();
  resetRunSnapshotWriteChainForTests();
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values)),
      },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(local, values)),
      },
    },
  });
  session.open_cowork_secrets = [];
  await primeLiveSecretRedaction();
});

afterEach(() => vi.unstubAllGlobals());

function controller(): RunController {
  const value = new RunController({
    runId: "run-1",
    task: "hey",
    maxSteps: 10,
    mode: "standard",
    now: 1,
  });
  value.markRunning(2);
  return value;
}

describe("run event snapshot projection", () => {
  test("redacts unstored key shapes before a provider event reaches the live transcript", () => {
    const raw = "Provider echoed sk-proj-SECRET1234567890TOKEN";
    const safe = redactLiveRunEvent({
      type: "error",
      step: 0,
      message: raw,
      recoverable: false,
      recovery: "Remove Bearer abcdefghijklmnopqrstuvwxyz and retry",
    });
    expect(JSON.stringify(safe)).not.toContain("SECRET1234567890TOKEN");
    expect(JSON.stringify(safe)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(raw).toContain("SECRET1234567890TOKEN");
  });

  test("projects progress without retaining reasoning or page content", () => {
    const value = controller();
    const snapshot = projectRunEvent(value, {
      type: "thinking",
      step: 2,
      text: "private reasoning",
      evaluation: "page-derived",
      memory: "history",
      nextGoal: "goal",
    });
    expect(snapshot).toMatchObject({
      phase: "reasoning",
      step: 3,
      activeOperation: "Reasoning",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private reasoning");
    expect(JSON.stringify(snapshot)).not.toContain("page-derived");
  });

  test("classifies typed empty-output terminal errors", () => {
    const snapshot = projectRunEvent(controller(), {
      type: "error",
      step: 0,
      message: "The model returned no visible answer.",
      recoverable: false,
      code: "EMPTY_MODEL_OUTPUT",
    });
    expect(snapshot).toMatchObject({
      status: "failed",
      phase: "terminal",
      terminalReason: "empty_output",
    });
  });

  test("error then done preserves the typed reason and agrees on the final result", () => {
    const value = controller();
    projectRunEvent(value, {
      type: "error",
      step: 0,
      message: "The model returned no visible answer.",
      recoverable: false,
      code: "EMPTY_MODEL_OUTPUT",
    });
    const final = projectRunEvent(value, {
      type: "done",
      step: 0,
      success: false,
      text: "No visible answer was produced. Select another model or reduce reasoning effort.",
    });
    expect(final).toMatchObject({
      status: "failed",
      terminalReason: "empty_output",
      terminalMessage: "No visible answer was produced. Select another model or reduce reasoning effort.",
      resultText: "No visible answer was produced. Select another model or reduce reasoning effort.",
    });

    const duplicate = projectRunEvent(value, {
      type: "done",
      step: 0,
      success: true,
      text: "late callback must not rewrite the result",
    });
    expect(duplicate).toEqual(final);
  });

  test("a late success cannot enrich or contradict an error terminal", () => {
    const value = controller();
    const failed = projectRunEvent(value, {
      type: "error",
      step: 0,
      message: "Provider failed",
      recoverable: false,
      code: "provider_error",
    });
    const late = projectRunEvent(value, {
      type: "done",
      step: 0,
      success: true,
      text: "late success must be ignored",
    });
    expect(late).toEqual(failed);
    expect(late.resultText).toBeUndefined();
  });

  test("cancellation freezes every late callback until terminal cleanup", () => {
    const value = controller();
    const cancellation = value.requestCancellation("Stop");
    const afterError = projectRunEvent(value, {
      type: "error",
      step: 1,
      message: "late provider failure",
      recoverable: false,
    });
    const afterDone = projectRunEvent(value, {
      type: "done",
      step: 1,
      success: true,
      text: "late provider success",
    });
    const afterCost = projectRunEvent(value, {
      type: "cost",
      step: 1,
      tokensIn: 99,
      tokensOut: 99,
      costUsd: 99,
      model: "late",
    });
    expect(afterError).toEqual(cancellation);
    expect(afterDone).toEqual(cancellation);
    expect(afterCost).toEqual(cancellation);

    const terminal = value.markTerminal("cancelled", "Stopped");
    expect(terminal).toMatchObject({ status: "cancelled", terminalReason: "cancelled" });
    expect(terminal.resultText).toBeUndefined();
  });

  test("first user-visible snapshot step matches RunBuilder history", () => {
    const event = { type: "navigator-step-start", step: 0, goal: "Read the page" } as const;
    const snapshot = projectRunEvent(controller(), event);
    const history = new RunBuilder("task");
    history.addEvent(event);
    const record = history.finish({ success: false, text: "stopped" });

    expect(snapshot.step).toBe(1);
    expect(record.stepCount).toBe(snapshot.step);
  });

  test("redacts an exact custom value from events, STATUS/STOP snapshots, history, and persistence", async () => {
    const secret = "hunter2";
    await setSecret("custom", secret);
    await primeLiveSecretRedaction();

    const value = controller();
    const event = redactLiveRunEvent({
      type: "error",
      step: 0,
      message: `Provider preview included ${secret}`,
      recovery: `Remove ${secret} and retry`,
      recoverable: false,
    });
    const projected = projectRunEvent(value, event);
    const stopProjection = redactLiveRunSnapshot(value.requestCancellation(`Stop ${secret}`));

    const history = new RunBuilder(`Task includes ${secret}`);
    history.addEvent(event);
    const record = history.finish({ success: false, text: `Result includes ${secret}` });
    await saveRun(record);
    await persistRunSnapshot({
      ...projected,
      task: `Task includes ${secret}`,
      terminalMessage: `Preview includes ${secret}`,
      resultText: `Result includes ${secret}`,
    });

    const persisted = session[LAST_RUN_SNAPSHOT_KEY];
    const historyRecord = (local.open_cowork_run_history as unknown[])[0];
    for (const projection of [event, projected, stopProjection, persisted, historyRecord]) {
      expect(JSON.stringify(projection)).not.toContain(secret);
    }
    expect(JSON.stringify(event)).toContain("[REDACTED:custom]");
  });

  test("masks every live string when the secret store cannot be read", async () => {
    // Clear the preceding test's in-module secret cache before simulating a
    // storage failure; real storage changes do the same via onChanged.
    await deleteSecret("custom");
    resetLiveSecretRedactionForTests();
    vi.mocked(chrome.storage.session.get).mockRejectedValueOnce(new Error("storage failed"));
    await primeLiveSecretRedaction();

    const secret = "hunter2";
    const event = redactLiveRunEvent({ type: "warn", message: `Provider echoed ${secret}` });
    const snapshot = redactLiveRunSnapshot({
      ...controller().snapshot,
      task: `Task ${secret}`,
      terminalMessage: `Preview ${secret}`,
    });
    await persistRunSnapshot(snapshot);

    for (const projection of [event, snapshot, session[LAST_RUN_SNAPSHOT_KEY]]) {
      expect(JSON.stringify(projection)).not.toContain(secret);
      expect(JSON.stringify(projection)).toContain("live secret redaction unavailable");
    }
  });
});
