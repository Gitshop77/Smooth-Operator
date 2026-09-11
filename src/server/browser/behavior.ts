/**
 * Thin, human-like behavior wrappers over `ghost-cursor`.
 *
 * These are delegation helpers only: `ghost-cursor` supplies the cubic Bezier
 * path, per-step jitter, and variable speed. This module maps our narrow
 * option surface onto it and adds a manual typing loop (ghost-cursor has no
 * typing). There is no stealth flag here — the caller decides whether to run
 * these wrappers at all.
 */

import type { Page } from "puppeteer-core";

type GhostCursorCtor = typeof import("ghost-cursor").GhostCursor;

async function createCursor(page: Page, start?: { x: number; y: number }): Promise<InstanceType<GhostCursorCtor>> {
  const { GhostCursor } = await import("ghost-cursor");
  return start ? new GhostCursor(page, { start }) : new GhostCursor(page);
}

/** Subset of ghost-cursor's `MoveToOptions` exposed by `humanMouseMove`. */
export interface MoveOptions {
  /** Explicit move duration in ms (mapped to ghost-cursor's `moveDelay`). */
  durationMs?: number;
  /** ghost-cursor `moveSpeed`. */
  moveSpeed?: number;
  /** Randomize the post-move delay. Defaults to `true`. */
  randomizeMoveDelay?: boolean;
  /** Override the generated path spread. */
  spreadOverride?: number;
}

/** Options for the manual typing loop. */
export interface TypeOptions {
  /** Minimum inter-keystroke delay in ms. */
  minDelayMs?: number;
  /** Maximum inter-keystroke delay in ms. */
  maxDelayMs?: number;
  /** Probability of an occasional longer "think" pause after a keystroke. */
  thinkPauseChance?: number;
  /** Lower bound of a think-pause duration in ms. */
  thinkPauseMinMs?: number;
  /** Upper bound of a think-pause duration in ms. */
  thinkPauseMaxMs?: number;
  /** Random source; defaults to `Math.random`. */
  rng?: () => number;
  /** Abort the typing loop before another key or delay is emitted. */
  signal?: AbortSignal;
}

const DEFAULT_TYPE: Required<Omit<TypeOptions, "rng" | "signal">> & { rng: () => number } = {
  // Keep interactions recognizably human without imposing multi-second
  // waits on every short field. Callers can still inject deterministic
  // timings and an RNG in tests.
  minDelayMs: 5,
  maxDelayMs: 20,
  thinkPauseChance: 0.01,
  thinkPauseMinMs: 40,
  thinkPauseMaxMs: 120,
  rng: Math.random,
};

/** Uniform sample in `[min, max)` from an injected random source. */
export function randomRange(min: number, max: number, rand: () => number = Math.random): number {
  const sample = rand();
  const boundedSample = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return min + boundedSample * (max - min);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Operation aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
    const onAbort = (): void => finish(() => reject(new Error("Operation aborted")));
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

/**
 * Human-like straight-line move from `(x1, y1)` to `(x2, y2)`.
 * ghost-cursor generates the curved path, jitter, and variable speed.
 */
export async function humanMouseMove(
  page: Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 80,
  options: MoveOptions = {},
): Promise<void> {
  const cursor = await createCursor(page, { x: x1, y: y1 });
  const configuredDuration = options.durationMs ?? durationMs;
  const moveDelay = Number.isFinite(configuredDuration) ? Math.max(0, Math.floor(configuredDuration)) : 0;
  await cursor.moveTo({ x: x2, y: y2 }, {
    moveDelay,
    randomizeMoveDelay: options.randomizeMoveDelay ?? true,
    ...(options.moveSpeed !== undefined && { moveSpeed: options.moveSpeed }),
    ...(options.spreadOverride !== undefined && { spreadOverride: options.spreadOverride }),
  });
}

/**
 * Type `text` one keystroke at a time with randomized per-key delays and
 * occasional think pauses. Space is emitted as key down/up; other characters
 * go through `keyboard.type`.
 */
export async function humanType(page: Page, text: string, options: TypeOptions = {}): Promise<void> {
  const rng = options?.rng ?? DEFAULT_TYPE.rng;
  const cfg = { ...DEFAULT_TYPE, ...options, rng };
  const keyboard = page.keyboard;

  for (const char of text) {
    if (cfg.signal?.aborted) {
      throw new Error("Operation aborted");
    }
    if (char === " ") {
      await keyboard.down("Space");
      await keyboard.up("Space");
    } else {
      await keyboard.type(char);
    }
    await sleep(randomRange(cfg.minDelayMs, cfg.maxDelayMs, cfg.rng), cfg.signal);
    if (cfg.rng() < cfg.thinkPauseChance) {
      await sleep(randomRange(cfg.thinkPauseMinMs, cfg.thinkPauseMaxMs, cfg.rng), cfg.signal);
    }
  }
}
