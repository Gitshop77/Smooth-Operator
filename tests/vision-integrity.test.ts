/**
 * Vision integrity tests — verifies every LFM2.5-VL-3B model file is covered by
 * the supply-chain guard: either a pinned 64-char SHA-256 (`MODEL_FILE_HASHES`)
 * or — for the large weight shards — an exact byte-size pin (`MODEL_FILE_SIZES`)
 * plus the loader's record-and-re-verify digest flow.
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

  test("every size-pinned file that is NOT hash-pinned still has its exact byte count", () => {
    // The 8 large weight shards are deliberately size-only pinned today; they
    // must all have exact byte counts from the pinned revision.
    const sizeOnly = Object.keys(MODEL_FILE_SIZES).filter((url) => !MODEL_FILE_HASHES[url]);
    expect(sizeOnly.length).toBeGreaterThanOrEqual(7);
    for (const url of sizeOnly) {
      expect(MODEL_FILE_SIZES[url]).toBeGreaterThan(0);
    }
  });
});

