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
