/**
 * Unit tests for security-critical single-point guards in the LLM layer:
 * - `encodeModelIdForUrl` (path/URL-injection guard)
 * - `hasImageProvenance` (image provenance gate against injected markers)
 * - `isValidCatalog` (negative/non-numeric cost + non-string release_date rejection)
 *
 * These pin behavior so a refactor that weakens any guard is caught by CI
 * rather than shipping silently.
 */

import { describe, test, expect } from "vitest";
import { encodeModelIdForUrl } from "../src/lib/agent/llm/modelId";
import { hasImageProvenance } from "../src/lib/agent/llm/shared-image";
import { isValidCatalog } from "../src/lib/agent/llm/catalog";

describe("encodeModelIdForUrl (path/URL-injection guard)", () => {
  test("accepts well-formed model ids unchanged", () => {
    expect(encodeModelIdForUrl("gpt-4o")).toBe("gpt-4o");
    expect(encodeModelIdForUrl("claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
    expect(encodeModelIdForUrl("model_v1.2")).toBe("model_v1.2");
  });

  test("rejects path-traversal and illegal characters", () => {
    expect(() => encodeModelIdForUrl("..")).toThrow();
    expect(() => encodeModelIdForUrl("..%2f")).toThrow();
    expect(() => encodeModelIdForUrl("a/../b")).toThrow();
    expect(() => encodeModelIdForUrl("bad\\id")).toThrow();
    expect(() => encodeModelIdForUrl("bad\x00id")).toThrow();
  });
});

describe("hasImageProvenance (image provenance gate)", () => {
  test("accepts a payload whose magic bytes match the declared type", () => {
    expect(hasImageProvenance("iVBORw0KGgoAAAA", "png")).toBe(true);
    expect(hasImageProvenance("/9j/AAAA", "jpeg")).toBe(true);
    expect(hasImageProvenance("UklGRAAAAAA", "webp")).toBe(true);
  });

  test("rejects a payload that does not match the declared type", () => {
    expect(hasImageProvenance("not-an-image", "png")).toBe(false);
    expect(hasImageProvenance("iVBORw0KGgoAAAA", "jpeg")).toBe(false);
    expect(hasImageProvenance("UklGRAAAAAA", "png")).toBe(false);
  });

  test("rejects an unknown media type", () => {
    expect(hasImageProvenance("iVBORw0KGgoAAAA", "gif")).toBe(false);
  });
});

describe("isValidCatalog (cost-cap + structural guard)", () => {
  const validCatalog = {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        m: { id: "m", name: "M", release_date: "2024-01-01" },
      },
    },
  };

  test("accepts a valid catalog with zero cost", () => {
    const catalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          m: { id: "m", name: "M", release_date: "2024-01-01", cost: { input: 0, output: 0 } },
        },
      },
    };
    expect(isValidCatalog(catalog)).toBe(true);
  });

  test("rejects a negative cost rate", () => {
    const catalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          m: { id: "m", name: "M", release_date: "2024-01-01", cost: { input: -1, output: 2 } },
        },
      },
    };
    expect(isValidCatalog(catalog)).toBe(false);
  });

  test("rejects a non-numeric cost rate", () => {
    const catalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          m: { id: "m", name: "M", release_date: "2024-01-01", cost: { input: "1" as unknown as number, output: 2 } },
        },
      },
    };
    expect(isValidCatalog(catalog)).toBe(false);
  });

  test("rejects a non-string release_date", () => {
    const catalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          m: { id: "m", name: "M", release_date: 20240101 as unknown as string },
        },
      },
    };
    expect(isValidCatalog(catalog)).toBe(false);
  });

  test("accepts the baseline valid catalog", () => {
    expect(isValidCatalog(validCatalog)).toBe(true);
  });
});
