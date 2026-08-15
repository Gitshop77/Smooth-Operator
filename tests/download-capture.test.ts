/**
 * Download-capture tests — the SW-side download ring in
 * message-routing.ts: recording completed `chrome.downloads.onChanged` deltas,
 * sanitization, mime guessing, ring cap, and the `list_downloads` TAB_ACTION
 * response. The module is imported dynamically so its top-level listener
 * registration runs against the chrome stub.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Module mocks (hoisted) — needed so `startRun` (agent-bridge) can run its
// run-start reset seam in-process: the loop, run-history, run-helpers and
// state-store are stubbed; the download ring + its run-lifecycle reset are the
// real code under test. Mirrors agent-bridge-startrun.test.ts.
vi.mock("@/lib/agent/loop/orchestrator", () => ({
  runAgentLoop: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/run-history", () => ({
  RunBuilder: class {
    private readonly events: unknown[] = [];
    get id(): string { return `test-run-${Math.random().toString(36).slice(2)}`; }
    get startedAt(): number { return 1; }
    addEvent(event: unknown): void { this.events.push(event); }
    finish(fallback: { success: boolean; text: string }) {
      const done = [...this.events].reverse().find((event): event is { type: "done"; success: boolean; text: string } =>
        typeof event === "object" && event !== null && (event as { type?: unknown }).type === "done",
      );
      return { result: done ? { success: done.success, text: done.text } : fallback };
    }
  },
}));

vi.mock("@/lib/agent/callbacks/metrics", () => ({
  AgentMetricsCallback: class {
    getMetrics() {
      return {
        totalSteps: 1, totalActions: 2, totalTokensIn: 3, totalTokensOut: 4,
        totalCostUsd: 0.5, errors: { total: 0 }, loopWarnings: 0, compactions: 0,
      };
    }
    reset(): void {}
  },
}));

vi.mock("../src/extension/background/run-helpers", () => ({
  buildLoopDeps: vi.fn((ctx: unknown) => ctx),
  cleanupRun: vi.fn(async () => {}),
  initRunState: vi.fn(async () => {}),
  resetVisionInitFlagForNewRun: vi.fn(),
  clearVisionElementsCacheForNewRun: vi.fn(),
  teardownScheduledVision: vi.fn(),
  wireAbortController: vi.fn(() => ({
    controller: { signal: { aborted: false } },
    onStorageChanged: vi.fn(),
  })),
  getVisionElementRect: vi.fn(),
  isVisionCacheFresh: vi.fn(),
}));

vi.mock("../src/extension/background/state-store", () => ({
  saveRunState: vi.fn(async () => {}),
  saveRunStateForRun: vi.fn(async () => {}),
  initializeRunStateForRun: vi.fn(async () => {}),
  getRunState: vi.fn(async () => undefined),
  clearRunState: vi.fn(async () => {}),
  clearRunStateForRun: vi.fn(async () => {}),
  loadAndSetDomainConfig: vi.fn(async () => {}),
  safeLog: vi.fn(async () => {}),
  stopKeepalive: vi.fn(async () => {}),
}));

import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";

type OnMessage = (msg: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined;
type OnDownloadsChanged = (delta: unknown) => void;

let onMessage: OnMessage | undefined;
let onDownloadsChanged: OnDownloadsChanged | undefined;

function installChromeStub() {
  onMessage = undefined;
  onDownloadsChanged = undefined;
  const base = makeChromeStorageMock(new Map(), new Map());
  const chrome = {
    ...base,
    runtime: {
      ...base.runtime,
      id: "extid",
      onMessage: { addListener: (cb: OnMessage) => { onMessage = cb; } },
      sendMessage: vi.fn(async () => {}),
    },
    downloads: {
      onChanged: { addListener: (cb: OnDownloadsChanged) => { onDownloadsChanged = cb; } },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: "https://example.com" }]),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chrome;
}

// The module registers its listeners once at import time, so the stub must
// be installed ONCE before the first dynamic import (a per-test reinstall
// would orphan the captured callbacks). Tests reset the ring via the
// exported clearCapturedDownloads instead.
beforeAll(() => {
  installChromeStub();
});

beforeEach(async () => {
  const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
  clearCapturedDownloads();
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

function completeDelta(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    state: { current: "complete", previous: "in_progress" },
    filename: { current: "report.pdf" },
    url: { current: "https://example.com/report.pdf" },
    mime: { current: "application/pdf" },
    fileSize: { current: 1234 },
    totalBytes: { current: 1234 },
    ...overrides,
  };
}

async function issueEffectCapability(
  token: { runId: string; dispatchRevision: number },
  action: { type: "list_downloads" },
): Promise<string> {
  const policy = await import("../src/extension/background/privileged-action-policy");
  const issued = policy.authorizeAndIssueEffectCapability(token, "standard", action);
  if (!issued.ok) throw new Error(issued.error);
  return issued.effectCapability;
}

describe("download capture ring", () => {
  test("records a completed download with sanitized fields", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    const rec = recordDownload(completeDelta() as never);
    expect(rec).not.toBeNull();
    const list = getCapturedDownloads();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: "report.pdf",
      url: "https://example.com/report.pdf",
      mime: "application/pdf",
      sizeBytes: 1234,
    });
  });

  test("strips signed query strings / tokens from the captured URL before the agent can read it", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    // Authenticated download URLs embed signed query strings; list_downloads
    // ships the ring verbatim to the agent, so the secret must be stripped at
    // capture time.
    recordDownload(completeDelta({
      url: { current: "https://example.com/export.csv?X-Amz-Signature=abc123def456&token=s3cr3t" },
    }) as never);
    const list = getCapturedDownloads();
    expect(list).toHaveLength(1);
    expect(list[0].url).not.toContain("X-Amz-Signature");
    expect(list[0].url).not.toContain("token=");
    expect(list[0].url).not.toContain("s3cr3t");
    expect(list[0].url).toBe("https://example.com/export.csv");
  });


  test("ignores non-complete transitions", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ state: { current: "in_progress", previous: "interrupted" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("ignores interrupted downloads", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ state: { current: "interrupted", previous: "in_progress" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("ignores zero-byte completes", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ fileSize: { current: 0 } }) as never);
    expect(getCapturedDownloads()).toHaveLength(0);
  });

  test("caps the ring at 20 records, dropping the oldest", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    for (let i = 1; i <= 25; i++) {
      recordDownload(completeDelta({ id: i, filename: { current: `file-${i}.txt` } }) as never);
    }
    const list = getCapturedDownloads();
    expect(list).toHaveLength(20);
    expect(list[0].filename).toBe("file-6.txt");
    expect(list[19].filename).toBe("file-25.txt");
  });

  test("guesses the mime from the filename when mime is absent", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ mime: { current: undefined } }) as never);
    expect(getCapturedDownloads()[0].mime).toBe("application/octet-stream");

    clearCapturedDownloads();
    recordDownload(completeDelta({ mime: undefined, filename: { current: "photo.png" } }) as never);
    expect(getCapturedDownloads()[0].mime).toBe("image/png");
  });

  test("sanitizes a traversal filename before storing", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta({ filename: { current: "../../evil.sh" } }) as never);
    const stored = getCapturedDownloads()[0].filename;
    expect(stored).not.toContain("..");
    expect(stored.includes("/")).toBe(false);
  });

  test("clearCapturedDownloads empties the ring", async () => {
    const { recordDownload, getCapturedDownloads, clearCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    recordDownload(completeDelta() as never);
    clearCapturedDownloads();
    expect(getCapturedDownloads()).toHaveLength(0);
  });
});

describe("list_downloads TAB_ACTION", () => {
  test("responds from the capture ring without delegating to tab-manager", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const controller = controllerModule.beginRunController({ runId: "downloads", task: "read", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    onDownloadsChanged?.(completeDelta() as never);
    onDownloadsChanged?.(completeDelta({ id: 2, filename: { current: "b.png" } }) as never);

    const sendResponse = vi.fn();
    const handled = onMessage?.(
      {
        type: "TAB_ACTION",
        action: { type: "list_downloads" },
        token: controller.dispatchToken,
        effectCapability: await issueEffectCapability(controller.dispatchToken, { type: "list_downloads" }),
      },
      { id: "extid" },
      sendResponse,
    );
    // Recovery authorization is asynchronous, so the listener keeps the
    // response channel open until the audited decision completes.
    expect(handled).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    const response = sendResponse.mock.calls[0][0] as {
      ok: boolean;
      success?: boolean;
      downloads?: Array<{ filename: string }>;
    };
    expect(response.ok).toBe(true);
    expect(response.success).toBe(true);
    expect(response.downloads).toHaveLength(2);
    expect(response.downloads![1].filename).toBe("b.png");
    controllerModule.resetRunControllerForTests();
  });

  test("reports an empty list when nothing was captured", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const controller = controllerModule.beginRunController({ runId: "downloads-empty", task: "read", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const { clearCapturedDownloads } = await import("../src/extension/background/message-routing");
    clearCapturedDownloads();
    const sendResponse = vi.fn();
    onMessage?.({
      type: "TAB_ACTION",
      action: { type: "list_downloads" },
      token: controller.dispatchToken,
      effectCapability: await issueEffectCapability(controller.dispatchToken, { type: "list_downloads" }),
    }, { id: "extid" }, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    const response = sendResponse.mock.calls[0][0] as { ok: boolean; downloads?: unknown[] };
    expect(response.ok).toBe(true);
    expect(response.downloads).toEqual([]);
    controllerModule.resetRunControllerForTests();
  });

  test("rejects an untokened delayed read while a run controller is active", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const controller = controllerModule.beginRunController({
      runId: "download-run",
      task: "read downloads",
      maxSteps: 1,
      mode: "standard",
    });
    controller.markRunning();
    const sendResponse = vi.fn();
    try {
      onMessage?.({ type: "TAB_ACTION", action: { type: "list_downloads" } }, { id: "extid" }, sendResponse);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false })));
    } finally {
      controllerModule.resetRunControllerForTests();
    }
  });

  test("rejects missing, wrong-action, and replayed list_downloads capabilities", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    const policy = await import("../src/extension/background/privileged-action-policy");
    controllerModule.resetRunControllerForTests();
    policy.resetPrivilegedActionPolicyForTests();
    const controller = controllerModule.beginRunController({ runId: "downloads-effects", task: "read", maxSteps: 1, mode: "standard" });
    controller.markRunning();
    const rpc = (message: Record<string, unknown>) => new Promise<unknown>((resolve) => {
      onMessage?.(message, { id: "extid" }, resolve);
    });
    try {
      await expect(rpc({ type: "TAB_ACTION", action: { type: "list_downloads" }, token: controller.dispatchToken }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const wrong = policy.authorizeAndIssueEffectCapability(controller.dispatchToken, "standard", { type: "get_network_log" });
      if (!wrong.ok) throw new Error(wrong.error);
      await expect(rpc({ type: "TAB_ACTION", action: { type: "list_downloads" }, token: controller.dispatchToken, effectCapability: wrong.effectCapability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
      const capability = await issueEffectCapability(controller.dispatchToken, { type: "list_downloads" });
      await expect(rpc({ type: "TAB_ACTION", action: { type: "list_downloads" }, token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      await expect(rpc({ type: "TAB_ACTION", action: { type: "list_downloads" }, token: controller.dispatchToken, effectCapability: capability }))
        .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/effect capability/i) }));
    } finally {
      policy.resetPrivilegedActionPolicyForTests();
      controllerModule.resetRunControllerForTests();
    }
  });

  test("rejects a predecessor token after worker memory loses its controller", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const sendResponse = vi.fn();
    onMessage?.(
      {
        type: "TAB_ACTION",
        action: { type: "list_downloads" },
        token: { runId: "pre-restart", dispatchRevision: 1 },
      },
      { id: "extid" },
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/stale/i) }),
    ));
  });
});

describe("download ring run-lifecycle reset", () => {
  // D1 finding 11: the capture ring is module state that previously survived
  // across runs — a prior run's downloads leaked into the next run's
  // list_downloads. startRun must clear the ring at the run-start seam.
  test("startRun clears the capture ring so list_downloads sees an empty ring", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const { startRun } = await import("../src/extension/background/agent-bridge");
    const { recordDownload, clearCapturedDownloads, getCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();

    // Seed the ring with "previous session" downloads.
    recordDownload(completeDelta() as never);
    recordDownload(completeDelta({ id: 2, filename: { current: "old-report.bin" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(2);

    await startRun({ task: "read", maxSteps: 5, mode: "standard" });

    expect(getCapturedDownloads()).toHaveLength(0);
    controllerModule.resetRunControllerForTests();
  });

  test("a second run does not see the first run's records (cross-run leak)", async () => {
    const controllerModule = await import("../src/extension/background/run-controller");
    controllerModule.resetRunControllerForTests();
    const { startRun } = await import("../src/extension/background/agent-bridge");
    const { recordDownload, clearCapturedDownloads, getCapturedDownloads } =
      await import("../src/extension/background/message-routing");
    clearCapturedDownloads();

    // Run 1 captures a download mid-run (in-run captures stay in scope).
    await startRun({ task: "run one", maxSteps: 5, mode: "standard" });
    recordDownload(completeDelta({ id: 11, filename: { current: "run1.pdf" } }) as never);
    expect(getCapturedDownloads()).toHaveLength(1);

    // Run 2 starts fresh: run 1's record must not leak into the new run.
    await startRun({ task: "run two", maxSteps: 5, mode: "standard" });
    expect(getCapturedDownloads()).toHaveLength(0);
    controllerModule.resetRunControllerForTests();
  });
});

describe("download consent lifecycle (D5 finding 15)", () => {
  // D5: `chrome.downloads.download()` resolves at INITIATION, not success, so
  // the one-time full-agentic consent must be consumed only on a terminal
  // "complete" delta — not when the download starts. Pending ids are tracked
  // in agent-bridge-utils; the message-routing onDownloadsChanged listener
  // resolves them (complete → consume, interrupted → release). A stuck
  // pending download keeps the reservation (fail-closed: next download
  // re-prompts).

  beforeEach(async () => {
    const { resetDownloadConsent } = await import("../src/extension/background/agent-bridge-utils");
    resetDownloadConsent();
  });

  test("initiate reserves consent; onChanged complete consumes it (no re-prompt)", async () => {
    const utils = await import("../src/extension/background/agent-bridge-utils");
    // First full-agentic download → saveAs required (consent reserved).
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
    utils.registerPendingDownload(42);

    // A second concurrent initiate must NOT prompt while the first is pending.
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(false);

    // Terminal complete delta → consent consumed. Observable via the mode
    // gate: a consumed consent never re-prompts.
    onDownloadsChanged?.(completeDelta({ id: 42, state: { current: "complete", previous: "in_progress" } }) as never);
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(false);
  });

  test("onChanged interrupted releases the reservation so the next download re-prompts", async () => {
    const utils = await import("../src/extension/background/agent-bridge-utils");
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
    utils.registerPendingDownload(7);

    onDownloadsChanged?.(completeDelta({ id: 7, state: { current: "interrupted", previous: "in_progress" } }) as never);
    // Reservation released → a retry prompts again (fail-open to re-prompt).
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
  });

  test("a failed download() (rejected initiate) releases the reservation", async () => {
    const utils = await import("../src/extension/background/agent-bridge-utils");
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
    utils.releaseDownloadConsentReservation();
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
  });

  test("a delta for an unregistered id does not touch the reservation", async () => {
    const utils = await import("../src/extension/background/agent-bridge-utils");
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
    // Delta for a download we never registered — must be ignored entirely.
    onDownloadsChanged?.(completeDelta({ id: 999, state: { current: "complete", previous: "in_progress" } }) as never);
    // Reservation still held → a second download does NOT re-prompt.
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(false);
  });

  test("non-full-agentic modes never consume or reserve consent", async () => {
    const utils = await import("../src/extension/background/agent-bridge-utils");
    expect(utils.consumeDownloadConsentForMode("standard")).toBe(false);
    expect(utils.consumeDownloadConsentForMode(undefined)).toBe(false);
    expect(utils.consumeDownloadConsentForMode("full_agentic")).toBe(true);
  });
});
