import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Page } from "puppeteer-core";

import {
  humanMouseMove,
  humanScroll,
  humanType,
  randomRange,
  thinkTime,
} from "@/server/browser/behavior";

vi.mock("ghost-cursor", () => {
  const ctorCalls: Array<[unknown, unknown]> = [];
  const moveTo = vi.fn().mockResolvedValue(undefined);
  const scrollTo = vi.fn().mockResolvedValue(undefined);
  const click = vi.fn().mockResolvedValue(undefined);
  class GhostCursor {
    moveTo = moveTo;
    scrollTo = scrollTo;
    click = click;
    constructor(page: unknown, opts?: unknown) {
      ctorCalls.push([page, opts]);
    }
  }
  return { GhostCursor, ctorCalls, moveTo, scrollTo, click };
});

import * as ghostCursor from "ghost-cursor";

interface MockedGhostCursor {
  GhostCursor: unknown;
  ctorCalls: Array<[unknown, unknown]>;
  moveTo: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
}

const gc = vi.mocked(ghostCursor as unknown as MockedGhostCursor);

beforeEach(() => {
  gc.ctorCalls.length = 0;
  gc.moveTo.mockClear();
  gc.scrollTo.mockClear();
});

function fakeKeyboard() {
  const calls: Array<{ action: string; arg?: string }> = [];
  return {
    calls,
    type: vi.fn((ch: string) => {
      calls.push({ action: "type", arg: ch });
    }),
    down: vi.fn((key: string) => {
      calls.push({ action: "down", arg: key });
    }),
    up: vi.fn((key: string) => {
      calls.push({ action: "up", arg: key });
    }),
  };
}

const fakePage = { keyboard: fakeKeyboard() } as unknown as Page;

describe("randomRange", () => {
  it("returns min when rand() is 0", () => {
    expect(randomRange(10, 20, () => 0)).toBe(10);
  });

  it("returns max when rand() is 1", () => {
    expect(randomRange(10, 20, () => 1)).toBe(20);
  });

  it("returns the midpoint when rand() is 0.5", () => {
    expect(randomRange(10, 20, () => 0.5)).toBe(15);
  });
});

describe("thinkTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a Promise that resolves at the sampled delay within [min, max]", async () => {
    let resolved = false;
    const p = thinkTime(100, 200, () => 0.5).then(() => {
      resolved = true;
    });
    expect(p).toBeInstanceOf(Promise);

    await vi.advanceTimersByTimeAsync(149);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("humanMouseMove", () => {
  it("constructs GhostCursor with the start point and delegates the move", async () => {
    await humanMouseMove(fakePage, 0, 0, 100, 200, 300, {});

    expect(gc.ctorCalls[0]).toEqual([fakePage, expect.objectContaining({ start: { x: 0, y: 0 } })]);
    expect(gc.moveTo).toHaveBeenCalledWith({ x: 100, y: 200 }, expect.objectContaining({ moveDelay: 300 }));
  });

  it("defaults randomizeMoveDelay to true", async () => {
    await humanMouseMove(fakePage, 0, 0, 10, 10, 200, {});
    expect(gc.moveTo).toHaveBeenCalledWith(
      { x: 10, y: 10 },
      expect.objectContaining({ randomizeMoveDelay: true }),
    );
  });
});

describe("humanScroll", () => {
  it("delegates to GhostCursor.scrollTo", async () => {
    await humanScroll(fakePage, "bottom", {});
    expect(gc.ctorCalls.length).toBe(1);
    expect(gc.ctorCalls[0]?.[0]).toBe(fakePage);
    expect(gc.scrollTo).toHaveBeenCalledWith("bottom", expect.any(Object));
  });
});

describe("humanType", () => {
  it("emits one keystroke per char with a delay between each and no think pause", async () => {
    const page = { keyboard: fakeKeyboard() } as unknown as Page;
    const start = Date.now();

    await humanType(page, "hi", { minDelayMs: 10, maxDelayMs: 20, thinkPauseChance: 0, rng: () => 0.5 });

    const elapsed = Date.now() - start;

    const kb = page.keyboard as unknown as { type: ReturnType<typeof vi.fn> };
    expect(kb.type).toHaveBeenCalledTimes(2);
    expect(kb.type).toHaveBeenCalledWith("h");
    expect(kb.type).toHaveBeenCalledWith("i");
    // Two inter-key delays of ~15ms each, no think pause => well under a think-pause window.
    expect(elapsed).toBeGreaterThanOrEqual(28);
    expect(elapsed).toBeLessThan(300);
  });

  it("does not throw when rng is explicitly undefined", async () => {
    const page = { keyboard: fakeKeyboard() } as unknown as Page;
    await expect(humanType(page, "x", { rng: undefined })).resolves.toBeUndefined();
  });

  it("fires a think pause when thinkPauseChance is certain", async () => {
    const page = { keyboard: fakeKeyboard() } as unknown as Page;
    const start = Date.now();

    await humanType(page, "hi", {
      minDelayMs: 10,
      maxDelayMs: 20,
      thinkPauseChance: 1,
      thinkPauseMinMs: 20,
      thinkPauseMaxMs: 40,
      rng: () => 0.5,
    });

    const elapsed = Date.now() - start;
    // Two keystrokes + two inter-key delays (~15ms) + two think pauses (~30ms).
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("emits Space as key down/up", async () => {
    const kb = fakeKeyboard();
    const page = { keyboard: kb } as unknown as Page;

    await humanType(page, "a b", { thinkPauseChance: 0, rng: () => 0 });

    expect(kb.type).toHaveBeenCalledWith("a");
    expect(kb.type).toHaveBeenCalledWith("b");
    expect(kb.down).toHaveBeenCalledWith("Space");
    expect(kb.up).toHaveBeenCalledWith("Space");
    expect(kb.calls.map((c) => c.action)).toEqual(["type", "down", "up", "type"]);
  });
});
