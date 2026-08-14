/**
 * Vision integrity tests — verifies every LFM2.5-VL-450M model file is covered by
 * the supply-chain guard: a pinned 64-char SHA-256 (`MODEL_FILE_HASHES`) so both
 * first-download AND every later cache re-verification are fully hash-sealed.
 * Sizes (`MODEL_FILE_SIZES`) are also pinned as a cheap second check.
 */

import { describe, test, expect } from "vitest";
import {
  MODEL_FILE_HASHES,
  MODEL_FILE_SIZES,
  modelFileEntries,
} from "../src/extension/vision-assistant/constants";

const HEX_64 = /^[0-9a-f]{64}$/;

describe("MODEL_FILE_HASHES", () => {
  test("contains a valid 64-char lowercase SHA-256 for every pinned file", () => {
    const pinned = Object.entries(MODEL_FILE_HASHES);
    expect(pinned.length).toBeGreaterThanOrEqual(10);
    for (const [, hash] of pinned) {
      expect(hash).toBeDefined();
      expect(hash).toMatch(HEX_64);
    }
  });

  test("no hash is the placeholder 000...0", () => {
    const placeholder = "0".repeat(64);
    for (const hash of Object.values(MODEL_FILE_HASHES)) {
      expect(hash).not.toBe(placeholder);
    }
  });
});

describe("MODEL_FILE_SIZES", () => {
  test("covers every model file (hash-pinned AND size-pinned) with a positive integer size", () => {
    for (const file of modelFileEntries("fp16")) {
      const size = MODEL_FILE_SIZES[file.url];
      expect(size, `missing size pin for ${file.name}`).toBeDefined();
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThan(0);
    }
  });

  test("every model file is FULLY hash-pinned (no size-only / unpinned weight shards)", () => {
    // Each of the 13 files in the fp16 variant must have a SHA-256 pin — the
    // supply-chain guard is at full strength for first-download AND cache
    // re-verification, with no reliance on size-only record-mode or any
    // unpinned-weights opt-in.
    const sizeOnly = Object.keys(MODEL_FILE_SIZES).filter((url) => !MODEL_FILE_HASHES[url]);
    expect(sizeOnly).toEqual([]);
    for (const file of modelFileEntries("fp16")) {
      expect(MODEL_FILE_HASHES[file.url], `missing hash pin for ${file.name}`).toBeDefined();
      expect(MODEL_FILE_HASHES[file.url]).toMatch(HEX_64);
    }
  });
});

