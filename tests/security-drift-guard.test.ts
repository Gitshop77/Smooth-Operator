import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

// These guards are security-critical and must not be silently weakened by a
// future refactor. Behavioral tests only check current behavior; they cannot
// detect a guard being renamed, dropped, or relaxed. This drift-guard greps
// the source so a weakening change fails CI even if every behavioral test
// still passes.
describe("security guard drift-guard", () => {
  it("keeps the ReDoS nested-quantifier guard (hasNestedQuantifier)", () => {
    const src = readSrc("src/lib/agent/tools/handlers/search-page.ts");
    expect(src).toContain("hasNestedQuantifier");
  });

  it("keeps the ReDoS backreference guard (hasBackreference)", () => {
    const src = readSrc("src/lib/agent/tools/handlers/search-page.ts");
    expect(src).toContain("hasBackreference");
  });

 // Token-presence alone is not enough: a self-heal refactor could keep the
 // guard definition while deleting the call site, and CI would still pass.
 // Assert the guards are actually invoked on the live code path.
  it("invokes the ReDoS guards on the live search-page handler path", () => {
    const src = readSrc("src/lib/agent/tools/handlers/search-page.ts");
    expect(src).toMatch(/hasNestedQuantifier\(\s*pattern\s*\)/);
    expect(src).toMatch(/hasBackreference\(\s*pattern\s*\)/);
  });

 // A behavioral regression test must exist so a ReDoS payload is rejected at
 // runtime, not merely that the guard text is present. Assert the test file
 // actually exercises the guards AND that it rejects a catastrophic pattern
 // (guard returns true for danger) while accepting a safe one (false) — proving
 // it distinguishes real ReDoS rather than always-rejecting.
  it("ships a behavioral ReDoS-rejection test", () => {
    const redos = readSrc("tests/search-page-redos.test.ts");
    expect(redos).toMatch(/hasNestedQuantifier|hasBackreference/);
    expect(redos).toMatch(
      /expect\(\s*has(?:NestedQuantifier|Backreference)\([\s\S]*?\)\s*\)\s*\.toBe\(\s*true\s*\)/,
    );
    expect(redos).toMatch(
      /expect\(\s*has(?:NestedQuantifier|Backreference)\([\s\S]*?\)\s*\)\s*\.toBe\(\s*false\s*\)/,
    );
  });

  it("keeps the SSRF link-local / cloud-metadata block (169.254 and fe80)", () => {
    const src = readSrc("src/lib/agent/llm/route/ssrf.ts");
    expect(src).toContain("169.254");
    expect(src).toContain("fe80");
  });

  it("keeps the user-provenance short-circuit in provider-config", () => {
    const src = readSrc("src/extension/provider-config.ts");
    expect(src).toContain('provenance === "user"');
  });

  it("keeps the verbatim SECURITY_INSTRUCTION marker", () => {
    const src = readSrc("src/lib/agent/security.ts");
    expect(src).toContain("SECURITY_INSTRUCTION");
  });
});
