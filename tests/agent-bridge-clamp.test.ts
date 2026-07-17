/**
 * agent-bridge.ts — clampInt / clampNumber numeric coercion guards.
 *
 * These normalize corrupted / NaN / negative / string storage values into safe
 * bounds before they reach the orchestrator's loop config.
 */

import { describe, test, expect } from "vitest";

const { clampInt, clampNumber } = await import(
  "../src/extension/background/agent-bridge"
);

describe("clampInt", () => {
  test("NaN -> def", () => {
    expect(clampInt(NaN, 5, 1, 10)).toBe(5);
  });

  test("undefined -> def", () => {
    expect(clampInt(undefined, 5, 1, 10)).toBe(5);
  });

  test("negative -> min", () => {
    expect(clampInt(-3, 5, 1, 10)).toBe(1);
  });

  test("over-max -> max", () => {
    expect(clampInt(50, 5, 1, 10)).toBe(10);
  });

  test("valid float -> floored", () => {
    expect(clampInt(3.9, 5, 1, 10)).toBe(3);
  });

  test("non-numeric string -> def", () => {
    expect(clampInt("abc", 5, 1, 10)).toBe(5);
  });
});

describe("clampNumber", () => {
  test("NaN -> def", () => {
    expect(clampNumber(NaN, 0, 0)).toBe(0);
  });

  test("undefined -> def", () => {
    expect(clampNumber(undefined, 0, 0)).toBe(0);
  });

  test("negative -> min", () => {
    expect(clampNumber(-1, 0, 0)).toBe(0);
  });

  test("valid value passes through", () => {
    expect(clampNumber(12, 0, 0)).toBe(12);
  });

  test("non-numeric string -> def", () => {
    expect(clampNumber("x", 0, 0)).toBe(0);
  });

  test("numeric string is coerced", () => {
    expect(clampNumber("7", 0, 0)).toBe(7);
  });
});
