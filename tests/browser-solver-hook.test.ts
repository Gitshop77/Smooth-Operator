import { describe, expect, it, vi } from "vitest";

import type { BrowserAction } from "@/server/contracts";
import { BrowserService } from "@/server/browser/service";
import { buildSolver } from "@/server/browser/solver";
import type { SolveRequest, SolveResult } from "@/server/browser/solver";
import type { Page } from "puppeteer-core";

import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";

import { testConfig } from "./helpers";

// The solver factory is stubbed so the gating logic can be exercised without a
// live browser or a network-bound provider.
vi.mock("@/server/browser/solver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/browser/solver")>();
  return { ...actual, buildSolver: vi.fn() };
});

const QUIET_LOGGER = new Logger("error", {}, () => undefined);

function fakePage(): Page {
  return {
    url: () => "https://example.com/challenge",
    evaluate: vi.fn(async () => true),
  } as unknown as Page;
}

function detection(status: "present" | "absent", kind = "recaptcha"): unknown {
  return {
    status,
    detected: status === "present",
    matches: status === "present" ? [{ kind, confidence: "high", indicators: [] }] : [],
    humanActionRequired: status === "present",
    bypassAttempted: false,
    url: "https://example.com/challenge",
    title: "Challenge",
  };
}

interface Svc {
  solveChallenge: (state: unknown, action: BrowserAction, signal?: AbortSignal) => Promise<unknown>;
  detectChallenge: (state: unknown, signal?: AbortSignal) => Promise<unknown>;
}

function service(): Svc {
  const config = testConfig();
  const instance = new BrowserService(config, new SecurityPolicy(config), QUIET_LOGGER);
  return instance as unknown as Svc;
}

const solveAction = { action: "solve_challenge", pageId: "test-page" } as unknown as BrowserAction;
const state = { id: "test-page", page: fakePage() } as unknown as { id: string; page: Page };

describe("solve_challenge gating", () => {
  it("falls back to HITL (bypassAttempted false) when no solver is configured", async () => {
    const svc = service();
    const detect = vi.spyOn(svc, "detectChallenge").mockResolvedValue(detection("present"));
    vi.mocked(buildSolver).mockReturnValue(null);

    const result = await svc.solveChallenge(state, solveAction);

    expect(result).toMatchObject({ solved: false, bypassAttempted: false, resolution: "no_solver_configured" });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("returns bypassAttempted false when the solver cannot handle the kind", async () => {
    const svc = service();
    vi.spyOn(svc, "detectChallenge").mockResolvedValue(detection("present", "recaptcha"));
    const supports = vi.fn(() => false);
    const solve = vi.fn();
    vi.mocked(buildSolver).mockReturnValue({ name: "test", supports, solve } as never);

    const result = await svc.solveChallenge(state, solveAction);

    expect(result).toMatchObject({ solved: false, bypassAttempted: false, resolution: "solver_unsupported" });
    expect(supports).toHaveBeenCalledWith("recaptcha", true);
    expect(solve).not.toHaveBeenCalled();
  });

  it("reports bypassAttempted true and solved true when the solver clears the challenge", async () => {
    const svc = service();
    vi.spyOn(svc, "detectChallenge")
      .mockResolvedValueOnce(detection("present", "recaptcha"))
      .mockResolvedValueOnce(detection("absent"));
    const solve = vi.fn(async (_req: SolveRequest, _signal: AbortSignal): Promise<SolveResult> => ({ token: "tok", fieldSelector: "gRecaptchaResponse" }));
    vi.mocked(buildSolver).mockReturnValue({ name: "test", supports: () => true, solve } as never);

    const result = await svc.solveChallenge(state, solveAction);

    expect(result).toMatchObject({ solved: true, bypassAttempted: true, resolution: "challenge_cleared", provider: "test", kind: "recaptcha" });
    expect(solve).toHaveBeenCalledTimes(1);
    const request = solve.mock.calls[0][0];
    expect(request.kind).toBe("recaptcha");
    expect(request.scoreBased).toBe(true);
    expect(request.pageurl).toBe("https://example.com/challenge");
  });

  it("reports bypassAttempted true when the solver throws", async () => {
    const svc = service();
    vi.spyOn(svc, "detectChallenge").mockResolvedValue(detection("present", "hcaptcha"));
    const solve = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.mocked(buildSolver).mockReturnValue({ name: "test", supports: () => true, solve } as never);

    const result = await svc.solveChallenge(state, solveAction);

    expect(result).toMatchObject({ solved: false, bypassAttempted: true, resolution: "solver_failed" });
    expect(solve).toHaveBeenCalledTimes(1);
  });
});
