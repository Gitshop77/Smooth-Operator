/**
 * Thin, human-like behavior wrappers over `ghost-cursor`.
 *
 * These are delegation helpers only: `ghost-cursor` supplies the cubic Bezier
 * path, per-step jitter, and variable speed. This module maps our narrow
 * option surface onto it and adds a manual typing loop (ghost-cursor has no
 * typing). There is no stealth flag here — the caller decides whether to run
 * these wrappers at all.
 */

import { GhostCursor } from "ghost-cursor";
import type { Page } from "puppeteer-core";

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

/** Subset of ghost-cursor's `ScrollOptions` exposed by `humanScroll`. */
export interface ScrollOptions {
  /** ghost-cursor `scrollSpeed` (0–100, 100 instant). */
  scrollSpeed?: number;
  /** ghost-cursor `scrollDelay`. */
  scrollDelay?: number;
}

/** ghost-cursor `ScrollToDestination`. */
export type ScrollDestination = Partial<{ x: number; y: number }> | "top" | "bottom" | "left" | "right";

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
}

const DEFAULT_TYPE: Required<Omit<TypeOptions, "rng">> & { rng: () => number } = {
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

const DEFAULT_SCROLL: Required<ScrollOptions> = {
  scrollSpeed: 90,
  scrollDelay: 20,
};

/** Uniform sample in `[min, max)` from an injected random source. */
export function randomRange(min: number, max: number, rand: () => number = Math.random): number {
  return min + rand() * (max - min);
}

/** Resolve after a randomized delay within `[minMs, maxMs]`. */
export function thinkTime(minMs = 20, maxMs = 120, rand: () => number = Math.random): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(randomRange(minMs, maxMs, rand))));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
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
  const cursor = new GhostCursor(page, { start: { x: x1, y: y1 } });
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
    if (char === " ") {
      await keyboard.down("Space");
      await keyboard.up("Space");
    } else {
      await keyboard.type(char);
    }
    await sleep(randomRange(cfg.minDelayMs, cfg.maxDelayMs, cfg.rng));
    if (cfg.rng() < cfg.thinkPauseChance) {
      await sleep(randomRange(cfg.thinkPauseMinMs, cfg.thinkPauseMaxMs, cfg.rng));
    }
  }
}

/** Human-like scroll to a destination via ghost-cursor. */
export async function humanScroll(page: Page, to: ScrollDestination, options: ScrollOptions = {}): Promise<void> {
  const cursor = new GhostCursor(page);
  const cfg = { ...DEFAULT_SCROLL, ...options };
  await cursor.scrollTo(to, {
    scrollSpeed: cfg.scrollSpeed,
    scrollDelay: cfg.scrollDelay,
  });
}
