/**
 * Phase 3 credential-visibility characterization.
 *
 * Session storage is explicitly restricted to Chrome trusted contexts. The browser E2E
 * companion proves that exact package behavior in a real isolated world; this
 * source guard makes a future privilege widening fail before a package exists.
 * The intentionally remembered `storage.local` key remains a separately
 * recorded expected failure in the browser lane (Phase 4/7/11 ownership).
 */

import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SOURCE_ROOT = path.join(process.cwd(), "src");

function hasUnsafeSessionAccessPolicy(text: string): boolean {
  if (/TRUSTED_AND_UNTRUSTED_CONTEXTS/.test(text)) return true;
  const calls = text.match(/\.storage\.session\.setAccessLevel\s*\([\s\S]{0,500}?\)/g) ?? [];
  // An explicit restriction to trusted extension contexts is safe. Unknown or
  // indirect access-level expressions fail closed because this source guard
  // cannot prove that they do not widen visibility to content contexts.
  const explicitTrustedRestriction =
    /(?:\baccessLevel\b|["']accessLevel["'])\s*:\s*["']TRUSTED_CONTEXTS["']/;
  return calls.some((call) => !explicitTrustedRestriction.test(call));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.(?:ts|tsx|js)$/.test(entry.name) ? [absolute] : [];
  });
}

describe("Phase 3 credential visibility contract", () => {
  test("source never widens chrome.storage.session to untrusted content contexts", () => {
    const violations = sourceFiles(SOURCE_ROOT).filter((file) => {
      const text = readFileSync(file, "utf8");
      return hasUnsafeSessionAccessPolicy(text);
    });
    expect(violations.map((file) => path.relative(process.cwd(), file))).toEqual([]);
    expect(readFileSync(
      path.join(process.cwd(), "src/extension/storage-access.ts"),
      "utf8",
    )).toContain('accessLevel: "TRUSTED_CONTEXTS"');
  });

  test("guard allows an explicit trusted-context restriction and rejects widening", () => {
    expect(hasUnsafeSessionAccessPolicy(
      "chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });",
    )).toBe(false);
    expect(hasUnsafeSessionAccessPolicy(
      "chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });",
    )).toBe(true);
    expect(hasUnsafeSessionAccessPolicy(
      "chrome.storage.session.setAccessLevel({ accessLevel: configuredLevel });",
    )).toBe(true);
    expect(hasUnsafeSessionAccessPolicy(
      "chrome.storage.session.setAccessLevel({ accessLevel: configuredLevel, note: 'TRUSTED_CONTEXTS' });",
    )).toBe(true);
  });

  test("source contract contains no hidden storage source outside the checked tree", () => {
    // Keep the recursive walk honest if a future refactor accidentally points
    // this test at an empty or non-directory path.
    expect(statSync(SOURCE_ROOT).isDirectory()).toBe(true);
    expect(sourceFiles(SOURCE_ROOT).length).toBeGreaterThan(0);
  });
});
