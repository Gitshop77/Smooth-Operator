/**
 * Coverage for `validateFileName`, the egress-boundary guard that rejects
 * path separators, ".." traversal segments, and control characters before a
 * file name is forwarded to the SW for screenshot / save_as_pdf.
 */

import { describe, test, expect } from "vitest";
import { validateFileName } from "../src/lib/agent/tools/handlers/validate-file-name";

describe("validateFileName (path-traversal egress guard)", () => {
  test("accepts undefined / null (SW falls back to a default name)", () => {
    expect(validateFileName(undefined)).toBeNull();
    expect(validateFileName(null)).toBeNull();
  });

  test("accepts sane bare names", () => {
    expect(validateFileName("screenshot.png")).toBeNull();
    expect(validateFileName("my-file_1.jpg")).toBeNull();
    expect(validateFileName("a.b")).toBeNull();
  });

  test("rejects path separators", () => {
    expect(validateFileName("a/b")).not.toBeNull();
    expect(validateFileName("a\\b")).not.toBeNull();
  });

  test("rejects '..' traversal segments", () => {
    expect(validateFileName("../../etc/passwd")).not.toBeNull();
    // A bare ".." name is also a traversal attempt (no separators needed — the
    // Windows-aware segment check catches it even without a "/" or "\" in the
    // name, e.g. ".." alone or a "..\\.." style name on Windows).
    expect(validateFileName("..")).not.toBeNull();
    expect(validateFileName("..\\..")).not.toBeNull();
    expect(validateFileName("...")).toBeNull(); // "..." is a valid bare name
  });

  test("rejects over-long names (120-char cap)", () => {
    expect(validateFileName("a".repeat(120))).toBeNull();
    expect(validateFileName("a".repeat(121))).not.toBeNull();
    expect(validateFileName("a".repeat(500))).not.toBeNull();
  });

  test("allows '..' as a substring in a filename", () => {
    expect(validateFileName("foo..bar")).toBeNull();
  });

  test("rejects control characters", () => {
    expect(validateFileName("a\u0000b")).not.toBeNull();
    expect(validateFileName("a\nb")).not.toBeNull();
  });

  test("rejects non-string / empty input", () => {
    expect(validateFileName(123)).not.toBeNull();
    expect(validateFileName("")).not.toBeNull();
  });
});
