/**
 * Test-architecture infrastructure pins.
 *
 * Pins the Verification tooling so the gates themselves cannot drift
 * silently:
 * - `scripts/test-duration-budget.mjs`: budget math (a negative or NaN
 *   elapsed time must throw; the comparison is inclusive at the boundary).
 * - `scripts/mutation-check.mjs`: every mutation target must match EXACTLY
 *   once in its production file (a source refactor that splits or renames the
 *   guarded line breaks the mutation harness loudly instead of silently
 *   mutating nothing); ids must be unique and every mutation must have at
 *   least the adversarial mutation suite attached.
 * - `scripts/flake-check.mjs`: every flake-prone file must exist and the
 *   round-count parser must reject invalid input.
 */

import { describe, expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isWithinBudget, formatElapsed, parseBudget } from "../scripts/test-duration-budget.mjs";
import { MUTATIONS, parseOnly } from "../scripts/mutation-check.mjs";
import { FLAKE_PRONE_FILES, parseRounds } from "../scripts/flake-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("test-duration-budget helpers", () => {
  test("isWithinBudget: inclusive at the boundary, false past it", () => {
    expect(isWithinBudget(179_999, 180_000)).toBe(true);
    expect(isWithinBudget(180_000, 180_000)).toBe(true);
    expect(isWithinBudget(180_001, 180_000)).toBe(false);
  });

  test("isWithinBudget rejects malformed inputs (never silently 'within')", () => {
    expect(() => isWithinBudget(Number.NaN, 1000)).toThrow();
    expect(() => isWithinBudget(-1, 1000)).toThrow();
    expect(() => isWithinBudget(1000, 0)).toThrow();
    expect(() => isWithinBudget(1000, Number.POSITIVE_INFINITY)).toThrow();
  });

  test("formatElapsed renders seconds with one decimal", () => {
    expect(formatElapsed(45_930)).toBe("45.9s");
    expect(formatElapsed(0)).toBe("0.0s");
  });

  test("parseBudget: default when no arg, positive finite override, rejection otherwise", () => {
    expect(parseBudget([])).toBe(180_000);
    expect(parseBudget(["90000"])).toBe(90_000);
    expect(() => parseBudget(["abc"])).toThrow();
    expect(() => parseBudget(["0"])).toThrow();
  });
});

describe("mutation-check table integrity", () => {
  test("mutation ids are unique and every mutation carries the mutation suite", () => {
    const ids = MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mutation of MUTATIONS) {
      expect(mutation.suites, `${mutation.id} must run the adversarial suite`).toContain(
        "tests/mutation-controls.test.ts",
      );
    }
  });

  test("every mutation's find string matches EXACTLY once in its production file", () => {
    for (const mutation of MUTATIONS) {
      const source = readFileSync(path.join(ROOT, mutation.file), "utf8");
      const occurrences = source.split(mutation.find).length - 1;
      expect(
        occurrences,
        `${mutation.id}: find must match exactly once in ${mutation.file}`,
      ).toBe(1);
    }
  });

  test("every referenced suite exists on disk", () => {
    const suites = new Set(MUTATIONS.flatMap((m) => m.suites));
    for (const suite of suites) {
      expect(existsSync(path.join(ROOT, suite)), `${suite} must exist`).toBe(true);
    }
  });

  test("parseOnly accepts comma-separated ids and rejects a missing list", () => {
    expect(parseOnly(["--only", "ssrf,redaction"])).toEqual(new Set(["ssrf", "redaction"]));
    expect(parseOnly([])).toBeNull();
    expect(() => parseOnly(["--only"])).toThrow();
  });
});

describe("flake-check table integrity", () => {
  test("every flake-prone file exists on disk", () => {
    for (const file of FLAKE_PRONE_FILES) {
      expect(existsSync(path.join(ROOT, file)), `${file} must exist`).toBe(true);
    }
  });

  test("parseRounds: default 3, positive integers only", () => {
    expect(parseRounds([])).toBe(3);
    expect(parseRounds(["5"])).toBe(5);
    expect(() => parseRounds(["0"])).toThrow();
    expect(() => parseRounds(["-1"])).toThrow();
    expect(() => parseRounds(["two"])).toThrow();
  });
});

// ─── Coverage-quality: the threshold config must be ENFORCED, not inert ──────

import config from "../vitest.config";

const THRESHOLD_KEYS = ["lines", "statements", "functions", "branches"] as const;

describe("coverage thresholds are real (vitest v4 object-form pins)", () => {
  const thresholds = (config as { test?: { coverage?: { thresholds?: Record<string, unknown> } } })
    .test?.coverage?.thresholds ?? {};

  test("all four global floors are enforced numbers above zero", () => {
    for (const key of THRESHOLD_KEYS) {
      const value = thresholds[key];
      expect(typeof value, `global ${key} threshold must be a number`).toBe("number");
      expect(value as number).toBeGreaterThan(0);
    }
  });

  test("every per-glob pin is the object form — a bare-number pin is silently ignored by vitest v4 and must never return", () => {
    for (const [glob, pin] of Object.entries(thresholds)) {
      if (THRESHOLD_KEYS.includes(glob as (typeof THRESHOLD_KEYS)[number])) continue;
      expect(typeof pin, `${glob}: per-glob pin must be the object form`).toBe("object");
      expect(pin, `${glob}: per-glob pin must be an object`).not.toBeNull();
      for (const key of THRESHOLD_KEYS) {
        const value = (pin as Record<string, unknown>)[key];
        expect(typeof value, `${glob}.${key} must be a number`).toBe("number");
        expect(value as number).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("every pinned security-module file exists on disk", () => {
    for (const glob of Object.keys(thresholds)) {
      if (THRESHOLD_KEYS.includes(glob as (typeof THRESHOLD_KEYS)[number])) continue;
      // Pins are exact file paths (no wildcards); the file must exist.
      expect(existsSync(path.join(ROOT, glob)), `${glob} must exist`).toBe(true);
    }
  });
});
