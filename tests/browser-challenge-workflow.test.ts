import { describe, expect, it, vi } from "vitest";

import type { BrowserAction } from "@/server/contracts";
import type { ServerConfig } from "@/server/config";
import { BrowserService, type PageSnapshot } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";

import { testConfig } from "./helpers";

const QUIET_LOGGER = new Logger("error", {}, () => undefined);

function service(config: ServerConfig = testConfig()): BrowserService {
  return new BrowserService(config, new SecurityPolicy(config), QUIET_LOGGER);
}

function detection(status: "present" | "absent" | "unknown"): unknown {
  return {
    status,
    detected: status === "present",
    matches: status === "present" ? [{ kind: "generic-challenge", confidence: "low", indicators: ["verify you are human"] }] : [],
    humanActionRequired: status !== "absent",
    ...(status === "unknown" ? { verification: "unverified" } : {}),
    url: "https://example.com/challenge",
    title: "Challenge",
  };
}

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    pageId: "page-1",
    frameId: "main",
    snapshotId: "snapshot-1",
    domRevision: 4,
    url: "https://example.com/challenge",
    title: "Challenge",
    text: "Verify you are human",
    textTruncated: false,
    headings: [],
    interactive: [{
      ref: "e1",
      index: 0,
      selector: "#verify",
      tag: "button",
      text: "Verify",
      disabled: false,
      rect: { x: 10, y: 20, width: 120, height: 40 },
    }],
    interactiveTruncated: false,
    viewport: { width: 800, height: 600 },
    document: { width: 800, height: 600 },
    readyState: "complete",
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    screenshotBase64: "aGVsbG8=",
    screenshot: { width: 800, height: 600, bytes: 5, format: "png", fullPage: false, scale: 1 },
    ...overrides,
  };
}

interface Internals {
  solveChallenge(state: { id: string; challengeStatus?: "present" | "absent" | "unknown" }, action: BrowserAction, signal?: AbortSignal): Promise<unknown>;
  detectChallenge(state: unknown, signal?: AbortSignal): Promise<unknown>;
  snapshotUnlocked(options: Record<string, unknown>): Promise<PageSnapshot>;
  executeOnPage(action: BrowserAction, signal?: AbortSignal): Promise<unknown>;
  pageState(pageId?: string, signal?: AbortSignal): Promise<unknown>;
  assertCurrentPageAllowed(page: unknown, state: unknown): Promise<void>;
  assertSnapshotForAction(state: unknown, action: BrowserAction): void;
  frameFor(state: unknown, frameId?: string): Promise<unknown>;
  clickTarget(state: unknown, target: string, button: "left" | "middle" | "right", count: number, signal?: AbortSignal, frame?: unknown, pointerType?: "mouse" | "touch"): Promise<unknown>;
}

const solveAction = { action: "solve_challenge", pageId: "page-1" } as BrowserAction;

describe("solve_challenge internal AI visual workflow", () => {
  it("returns a verified solved result when no challenge is present", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    vi.spyOn(internal, "detectChallenge").mockResolvedValue(detection("absent"));
    const capture = vi.spyOn(internal, "snapshotUnlocked");

    const result = await internal.solveChallenge({ id: "page-1" }, solveAction);

    expect(result).toMatchObject({ solved: true, verified: true, resolution: "no_challenge", verification: "verified", workflow: "verified", pageId: "page-1" });
    expect(capture).not.toHaveBeenCalled();
    await instance.close();
  });

  it("reports challenge_cleared only after a fresh absent detection", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    const state = { id: "page-1" as const };
    vi.spyOn(internal, "detectChallenge")
      .mockResolvedValueOnce(detection("present"))
      .mockResolvedValueOnce(detection("absent"));
    vi.spyOn(internal, "snapshotUnlocked").mockResolvedValue(snapshot());

    const pending = await internal.solveChallenge(state, solveAction);
    expect(pending).toMatchObject({ solved: false, verified: true, resolution: "challenge_present", verification: "challenge_present", workflow: "ai_action_required" });
    const cleared = await internal.solveChallenge(state, solveAction);
    expect(cleared).toMatchObject({ solved: true, verified: true, resolution: "challenge_cleared", verification: "verified", workflow: "verified" });
    await instance.close();
  });

  it("returns one bounded visual handoff with stable refs and top-level image fields", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    vi.spyOn(internal, "detectChallenge").mockResolvedValue(detection("present"));
    const capture = vi.spyOn(internal, "snapshotUnlocked").mockResolvedValue(snapshot());

    const result = await internal.solveChallenge({ id: "page-1" }, {
      ...solveAction,
      includeScreenshot: true,
      fullPage: false,
      maxDimension: 20_000,
      maxChars: 20_000,
    } as BrowserAction);
    const value = result as Record<string, unknown>;

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ includeScreenshot: true, maxDimension: 1_600, maxChars: 8_000, pageId: "page-1" }));
    expect(value).toMatchObject({
      solved: false,
      workflow: "ai_action_required",
      pageId: "page-1",
      frameId: "main",
      snapshotId: "snapshot-1",
      viewport: { width: 800, height: 600 },
      refs: [{ ref: "e1", selector: "#verify" }],
      screenshotBase64: "aGVsbG8=",
      mimeType: "image/png",
      metadata: { width: 800, height: 600, bytes: 5, format: "png" },
      nextAction: expect.stringContaining("normal browser"),
    });
    expect((value.snapshot as Record<string, unknown>).screenshotBase64).toBeUndefined();
    await instance.close();
  });

  it("does not call any provider or fetch path", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    vi.spyOn(internal, "detectChallenge").mockResolvedValue(detection("present"));
    vi.spyOn(internal, "snapshotUnlocked").mockResolvedValue(snapshot({ screenshotBase64: undefined, screenshot: undefined }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await internal.solveChallenge({ id: "page-1" }, solveAction);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await instance.close();
  });

  it("allows normal challenge interaction actions while a challenge is observed", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    const state = {
      id: "page-1",
      challengeStatus: "present" as const,
      navigationGeneration: 0,
      activeNavigationGeneration: undefined as number | undefined,
      navigationError: undefined,
      page: { url: () => "https://example.com/challenge" },
    };
    vi.spyOn(internal, "pageState").mockResolvedValue(state);
    vi.spyOn(internal, "assertCurrentPageAllowed").mockResolvedValue(undefined);
    vi.spyOn(internal, "assertSnapshotForAction").mockImplementation(() => undefined);
    vi.spyOn(internal, "frameFor").mockResolvedValue({});
    const click = vi.spyOn(internal, "clickTarget").mockResolvedValue({ navigated: false, urlChanged: false });

    await expect(internal.executeOnPage({ action: "click", target: "#verify" } as BrowserAction)).resolves.toMatchObject({ clicked: true, pageId: "page-1" });
    expect(click).toHaveBeenCalledWith(state, "#verify", "left", 1, undefined, {}, "mouse");
    await instance.close();
  });

  it("keeps an unknown detection explicitly unverified and never claims success", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    vi.spyOn(internal, "detectChallenge").mockResolvedValue(detection("unknown"));
    const capture = vi.spyOn(internal, "snapshotUnlocked");

    const result = await internal.solveChallenge({ id: "page-1" }, solveAction);

    expect(result).toMatchObject({ solved: false, verified: false, resolution: "challenge_state_unverified", verification: "unknown", workflow: "verification_unavailable" });
    expect(capture).not.toHaveBeenCalled();
    await instance.close();
  });

  it("keeps retrying the connected-AI loop before exposing handoff", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    vi.spyOn(internal, "detectChallenge").mockResolvedValue(detection("present"));
    vi.spyOn(internal, "snapshotUnlocked").mockResolvedValue(snapshot());

    const state = { id: "page-1" as const };
    const first = await internal.solveChallenge(state, { ...solveAction, maxAttempts: 2 } as BrowserAction);
    const second = await internal.solveChallenge(state, { ...solveAction, maxAttempts: 2 } as BrowserAction);
    const exhausted = await internal.solveChallenge(state, { ...solveAction, maxAttempts: 2 } as BrowserAction);

    expect(first).toMatchObject({ workflow: "ai_action_required", attempts: 1, attemptsRemaining: 1 });
    expect(second).toMatchObject({ workflow: "ai_action_required", attempts: 2, attemptsRemaining: 0 });
    expect(exhausted).toMatchObject({ workflow: "human_handoff_available", resolution: "automation_exhausted", attempts: 2, attemptsRemaining: 0 });
    await instance.close();
  });

  it("propagates cancellation from detection instead of converting it to success", async () => {
    const instance = service();
    const internal = instance as unknown as Internals;
    const controller = new AbortController();
    vi.spyOn(internal, "detectChallenge").mockImplementation(async (_state, signal) => {
      controller.abort();
      if (signal?.aborted) {
        throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
      }
      return detection("unknown");
    });

    await expect(internal.solveChallenge({ id: "page-1" }, solveAction, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    await instance.close();
  });
});

describe("solve_challenge operation budget", () => {
  it("uses the normal action deadline without a separate polling budget", async () => {
    const instance = service();
    const withLock = vi.spyOn(instance as unknown as { withOperationLock: (...args: unknown[]) => Promise<unknown> }, "withOperationLock")
      .mockResolvedValue(undefined);
    await instance.execute({ action: "solve_challenge", pageId: "page-1" } as BrowserAction);
    const call = withLock.mock.calls[0] as unknown[];
    expect(call[2]).toBe(15_000);
    expect(call[3]).toBe(15_000);
  });
});
