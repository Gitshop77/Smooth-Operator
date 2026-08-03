/**
 * antibot.ts — `makeAntiBotHooks` detection-error trust-boundary sentinel.
 *
 * The orchestrator treats a detected anti-bot challenge as a reason to pause,
 * but it must NOT treat a *detection error* (the injection itself failed — the
 * tab may be on a possibly-injected page) as "all clear". `detectChallenge`
 * encodes that distinction: a failed detection returns a truthy
 * `{ kind: "detection-error" }` sentinel so the orchestrator pauses rather than
 * proceeding blindly, while a genuine "no challenge" returns `null`. A refactor
 * that accidentally turned the error branch into `null` would be a silent
 * security regression.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("@/extension/background/state-store", () => ({
  getRunState: vi.fn(),
}));
vi.mock("@/extension/background/rate-limit-tracker", () => ({
  consumeRecentRateLimit: vi.fn(),
}));
vi.mock("@/lib/agent/anti-bot", () => ({
  detectChallengeResult: vi.fn(),
  waitForChallengeResolution: vi.fn(),
}));

import { makeAntiBotHooks } from "../src/extension/background/antibot";
import { getRunState } from "@/extension/background/state-store";
import { consumeRecentRateLimit } from "@/extension/background/rate-limit-tracker";
import { detectChallengeResult, waitForChallengeResolution } from "@/lib/agent/anti-bot";

const validRunState = { currentTabId: 5, active: true } as never;

beforeEach(() => {
  (getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(validRunState);
  (consumeRecentRateLimit as unknown as ReturnType<typeof vi.fn>).mockReset();
  (consumeRecentRateLimit as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (detectChallengeResult as unknown as ReturnType<typeof vi.fn>).mockReset();
  (waitForChallengeResolution as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe("makeAntiBotHooks detection-error sentinel", () => {
  test("a detection error returns a truthy detection-error sentinel (not null)", async () => {
    (detectChallengeResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "error",
      error: "injection failed",
    });
    const hooks = makeAntiBotHooks();
    const result = await hooks.detectChallenge();
    expect(result).toBeTruthy();
    expect((result as { kind: string }).kind).toBe("detection-error");
  });

  test("a genuine challenge returns its info object", async () => {
    const info = { foo: "bar" };
    (detectChallengeResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "challenge",
      info,
    });
    const hooks = makeAntiBotHooks();
    const result = await hooks.detectChallenge();
    expect(result).toEqual(info);
  });

  test("a clear page returns null (proceed)", async () => {
    (detectChallengeResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "clear",
    });
    const hooks = makeAntiBotHooks();
    const result = await hooks.detectChallenge();
    expect(result).toBeNull();
  });

  test("waitForChallengeResolution passes through timeoutMs=15000 and jittered pollMs", async () => {
    (waitForChallengeResolution as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      resolved: true,
    });
    const hooks = makeAntiBotHooks();
    const resolved = await hooks.waitForChallengeResolution();
    expect(resolved).toBe(true);
    expect(waitForChallengeResolution).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    const pollMs = (waitForChallengeResolution as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].pollMs;
    expect(pollMs).toBeGreaterThanOrEqual(500);
    expect(pollMs).toBeLessThan(600);
  });
});

// ─── makeAntiBotHooks fallbacks (no-valid-tab / rate-limited / catch-all) ───

describe("makeAntiBotHooks fallbacks", () => {
  test("no valid tab in RunState → detectChallenge returns null without touching the detectors", async () => {
    (getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const hooks = makeAntiBotHooks();
    expect(await hooks.detectChallenge()).toBeNull();
    expect(detectChallengeResult).not.toHaveBeenCalled();
  });

  test("RunState with a missing/invalid tab (not active) → waitForChallengeResolution returns false", async () => {
    (getRunState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ currentTabId: 5 });
    const hooks = makeAntiBotHooks();
    expect(await hooks.waitForChallengeResolution()).toBe(false);
    expect(waitForChallengeResolution).not.toHaveBeenCalled();
  });

  test("rate-limited (fresh 429/503 recorded) → rate-limited sentinel, detectors untouched", async () => {
    (consumeRecentRateLimit as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const hooks = makeAntiBotHooks();
    const result = await hooks.detectChallenge();
    expect(result).toEqual({
      kind: "rate-limited",
      message: "Server returned HTTP 429/503 (rate limited).",
    });
    expect(consumeRecentRateLimit).toHaveBeenCalledWith(5);
    expect(detectChallengeResult).not.toHaveBeenCalled();
  });

  test("detectChallenge never throws — a thrown detector is caught and reported as null", async () => {
    (detectChallengeResult as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom"),
    );
    const hooks = makeAntiBotHooks();
    expect(await hooks.detectChallenge()).toBeNull();
  });

  test("waitForChallengeResolution never throws — a thrown resolver is caught as unresolved", async () => {
    (waitForChallengeResolution as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom"),
    );
    const hooks = makeAntiBotHooks();
    expect(await hooks.waitForChallengeResolution()).toBe(false);
  });
});
