import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/extension/background/run-snapshot-store", () => ({
  persistRunSnapshot: vi.fn(async () => {}),
}));

vi.mock("../src/extension/background/run-session-state", () => ({
  runSessionState: { patch: vi.fn(async () => {}) },
}));

// Dependencies needed to load the REAL run-helpers module for the cleanupRun
// terminal-event contract test (mirrors tests/vision-cache-freshness.test.ts).
vi.mock("@/lib/agent/llm/catalog", () => ({
  modelSupportsVision: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/extension/provider-config-map", () => ({
  CATALOG_PROVIDER_ID_MAP: {},
}));

vi.mock("@/extension/background/tab-manager", () => ({
  extractStateFromTab: vi.fn().mockResolvedValue({
    url: "https://example.com", title: "Test", tabs: [], elements: [], elementsText: "",
    pageInfo: "", newElementCount: 0, scrollTop: 0, scrollHeight: 1000,
    viewportHeight: 800, selectorMap: {}, devicePixelRatio: 1,
  }),
  listTabs: vi.fn().mockResolvedValue([]),
  ensureContent: vi.fn().mockResolvedValue(undefined),
  executeActionsInTab: vi.fn().mockResolvedValue([]),
  waitForTabLoad: vi.fn().mockResolvedValue(undefined),
  handleTabAction: vi.fn().mockResolvedValue(undefined),
  getPageFingerprint: vi.fn().mockResolvedValue(""),
  getPageSnapshot: vi.fn().mockResolvedValue({ fingerprint: "", viewport: "" }),
  sendMessageWithTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/extension/background/screenshots", () => ({
  captureTabScreenshot: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
}));

vi.mock("@/extension/llm-direct", () => ({
  navigatorCallDirect: vi.fn(),
  plannerCallDirect: vi.fn(),
  summarizeCallDirect: vi.fn(),
}));

vi.mock("@/extension/background/state-store", () => ({
  getRunState: vi.fn().mockResolvedValue({ currentTabId: 1, step: 0 }),
  saveRunState: vi.fn(),
  clearRunState: vi.fn(),
  RUN_STATE_KEY: "open_cowork_run_state",
  startKeepalive: vi.fn(),
  stopKeepalive: vi.fn(),
  maybeReleaseKeepAwake: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("@/extension/provider-config", () => ({
  resolveModel: vi.fn(() => "mock-model"),
}));

vi.mock("@/extension/background/antibot", () => ({
  makeAntiBotHooks: vi.fn().mockReturnValue({}),
}));

vi.mock("@/extension/vision-assistant", () => ({
  VisionAssistant: vi.fn().mockImplementation(() => ({
    isReady: false,
    init: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
  mergeDetections: vi.fn().mockReturnValue([]),
  renderMergedElementsText: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/agent/run-history", () => ({
  RunBuilder: vi.fn(),
  saveRun: vi.fn(),
}));

vi.mock("@/lib/agent/modes", () => ({
  checkActionAllowed: vi.fn().mockReturnValue({ allowed: true }),
}));

import { RunEventService } from "../src/extension/background/run-event-service";
import { beginRunController, resetRunControllerForTests } from "../src/extension/background/run-controller";
import { persistRunSnapshot } from "../src/extension/background/run-snapshot-store";
import { runSessionState } from "../src/extension/background/run-session-state";
import type { RunBuilder } from "../src/lib/agent/run-history";
import { primeLiveSecretRedaction } from "../src/lib/agent/secrets";

const persistSnapshot = vi.mocked(persistRunSnapshot);
const patchRunState = vi.mocked(runSessionState.patch);

function makeService() {
  const controller = beginRunController({
    runId: "event-run",
    task: "task",
    maxSteps: 10,
    mode: "standard",
  });
  controller.markRunning();
  const addEvent = vi.fn();
  const runBuilder = { addEvent } as unknown as RunBuilder;
  const service = new RunEventService(controller, runBuilder);
  service.setRunState({
    runId: "event-run",
    dispatchRevision: controller.dispatchToken.dispatchRevision,
    task: "task",
    maxSteps: 10,
    mode: "standard",
    startTabId: 1,
    currentTabId: 1,
    step: 0,
    active: true,
    abortRequested: false,
  });
  return { controller, service, addEvent };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetRunControllerForTests();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { sendMessage: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({})) },
      session: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(async () => {}),
      },
      onChanged: { removeListener: vi.fn(), addListener: vi.fn() },
    },
  };
  await primeLiveSecretRedaction();
});

describe("RunEventService", () => {
  test("projects, records, persists, broadcasts, then patches navigator progress", async () => {
    const { service, addEvent } = makeService();

    service.emit({ type: "navigator-step-start", step: 3 });
    await Promise.resolve();

    expect(addEvent).toHaveBeenCalledWith({ type: "navigator-step-start", step: 3 });
    expect(persistSnapshot).toHaveBeenCalledWith(expect.objectContaining({ runId: "event-run", step: 4 }));
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "AGENT_EVENT",
      runId: "event-run",
      event: { type: "navigator-step-start", step: 3 },
    }));
    expect(patchRunState).toHaveBeenCalledWith(expect.objectContaining({ runId: "event-run" }), { step: 3 });
    expect(service.currentStep).toBe(3);
  });

  test("broadcasts stream progress without persisting or bloating run history", () => {
    const { service, addEvent } = makeService();
    service.emit({
      type: "llm-call-progress", step: 1, callId: "nav-1", role: "navigator",
      attempt: 1, outputChars: 512, chunkCount: 22, elapsedMs: 4500,
    });

    expect(addEvent).not.toHaveBeenCalled();
    expect(persistSnapshot).not.toHaveBeenCalled();
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ type: "llm-call-progress", outputChars: 512 }),
    }));
  });

  test("accepts one terminal result and rejects every late callback", () => {
    const { service, addEvent } = makeService();

    service.emit({ type: "done", step: 1, success: true, text: "complete" });
    service.emit({ type: "cost", step: 1, tokensIn: 2, tokensOut: 3, costUsd: 1, model: "late" });

    expect(service.runSucceeded).toBe(true);
    expect(addEvent).toHaveBeenCalledTimes(1);
    expect(patchRunState).not.toHaveBeenCalled();
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("preserves nonrecoverable error then done(false) as one enriched terminal sequence", () => {
    const { controller, service, addEvent } = makeService();
    const markTerminal = vi.spyOn(controller, "markTerminal");

    service.emit({
      type: "error",
      step: 2,
      message: "provider stream malformed",
      recoverable: false,
      code: "PROTOCOL_MALFORMED",
    });
    service.emit({ type: "done", step: 2, success: false, text: "Could not complete the task." });
    service.emit({ type: "done", step: 2, success: false, text: "late duplicate" });
    service.emit({ type: "info", message: "late info" });

    expect(markTerminal).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toMatchObject({
      status: "failed",
      terminalReason: "protocol_error",
      terminalMessage: "Could not complete the task.",
      resultText: "Could not complete the task.",
    });
    expect(addEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ type: "error", message: "provider stream malformed" }),
      { type: "done", step: 2, success: false, text: "Could not complete the task." },
    ]);
    const envelopes = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(
      ([message]) => message as unknown as { revision: number; event: { type: string } },
    );
    expect(envelopes.map(({ event }) => event.type)).toEqual(["error", "done"]);
    expect(envelopes[1].revision).toBeGreaterThan(envelopes[0].revision);
    const snapshots = persistSnapshot.mock.calls.map(([snapshot]) => snapshot);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ status: "failed", terminalReason: "protocol_error" });
    expect(snapshots[0].resultText).toBeUndefined();
    expect(snapshots[1]).toMatchObject({
      status: "failed",
      terminalReason: "protocol_error",
      resultText: "Could not complete the task.",
    });
  });

  test("emits the cancellation transcript once with ordered revisions", () => {
    const { controller, service, addEvent } = makeService();
    controller.requestCancellation("Stop requested by user.");

    service.sendCancellationTranscript();
    service.sendCancellationTranscript();

    const envelopes = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(
      ([message]) => message as unknown as { revision: number; event: { type: string } },
    );
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((message) => message.revision)).toEqual([
      controller.snapshot.revision + 1,
      controller.snapshot.revision + 2,
    ]);
    expect(envelopes.map((message) => message.event.type)).toEqual(["info", "done"]);
    expect(addEvent).not.toHaveBeenCalled();
  });
});

describe("cleanupRun terminal-event contract", () => {
  test("cleanupRun never broadcasts the dead terminal 'Run finished.' info event", async () => {
    vi.resetModules();
    const { cleanupRun } = await import("../src/extension/background/run-helpers");
    const sendEvent = vi.fn();
    const runBuilder = {
      finish: vi.fn(() => ({ result: { success: false, text: "done", terminalReason: "cancelled" } })),
    } as unknown as RunBuilder;

    await cleanupRun({
      runBuilder,
      task: "task",
      isScheduledTaskRun: false,
      onStorageChanged: vi.fn(),
      sendEvent,
      runSucceeded: false,
      releaseRunGuard: vi.fn(),
      teardownScheduledVision: vi.fn(async () => {}),
      abortSignal: new AbortController().signal,
      terminalSnapshot: {
        runId: "run-finished",
        status: "cancelled",
        terminalReason: "cancelled",
        resultText: "Stop requested by user.",
        terminalMessage: "Stop requested by user.",
      } as never,
    });

    // The terminal 'Run finished.' info event is dead code: RunEventService
    // drops every emit after the run is terminal, so the panel only ever sees
    // done/error/cancelled. It must never be sent.
    expect(sendEvent).not.toHaveBeenCalledWith({ type: "info", message: "Run finished." });
  });
});
