/**
 * Vision integrity tests — verifies MODEL_FILE_HASHES pins all 7 model files
 * with valid 64-char hex SHA-256 digests.
 */

import { describe, test, expect } from "vitest";
import {
  MODEL_FILE_HASHES,
  VISION_GRAPH_URL,
  VISION_DATA_URL,
  LANGUAGE_GRAPH_URL,
  LANGUAGE_DATA_URL,
  EMBED_PACKED_URL,
  EMBED_SCALES_URL,
  EMBED_META_URL,
} from "../src/extension/vision-assistant/constants";

const HEX_64 = /^[0-9a-f]{64}$/;

const ALL_URLS = [
  VISION_GRAPH_URL,
  VISION_DATA_URL,
  LANGUAGE_GRAPH_URL,
  LANGUAGE_DATA_URL,
  EMBED_PACKED_URL,
  EMBED_SCALES_URL,
  EMBED_META_URL,
];

describe("MODEL_FILE_HASHES", () => {
  test("contains entries for all 7 model file URLs", () => {
    for (const url of ALL_URLS) {
      expect(MODEL_FILE_HASHES).toHaveProperty(url);
    }
  });

  test("every hash is a valid 64-char lowercase hex string", () => {
    for (const url of ALL_URLS) {
      const hash = MODEL_FILE_HASHES[url];
      expect(hash).toBeDefined();
      expect(hash).toMatch(HEX_64);
    }
  });

  test("no hash is the placeholder 000...0", () => {
    const placeholder = "0".repeat(64);
    for (const url of ALL_URLS) {
      expect(MODEL_FILE_HASHES[url]).not.toBe(placeholder);
    }
  });
});
