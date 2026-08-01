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
 // Assert the guards are actually invoked on the live code path — either
 // directly or via the checkRedos helper that wraps them.
  it("invokes the ReDoS guards on the live search-page handler path", () => {
    const src = readSrc("src/lib/agent/tools/handlers/search-page.ts");
    const callsGuardsDirectly =
      /hasNestedQuantifier\(\s*pattern\s*\)/.test(src) &&
      /hasBackreference\(\s*pattern\s*\)/.test(src);
    const callsCheckRedos = /checkRedos\(\s*pattern\s*\)/.test(src);
    expect(callsGuardsDirectly || callsCheckRedos).toBe(true);
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
 // ssrf.ts only mentions 169.254 / fe80 in its header comment, so grepping
 // ssrf.ts would pass even if the real guards were deleted. Assert against
 // the CODE in ssrf-ipv6.ts instead: isSsrfSinkIpv4 rejects 169.254.0.0/16
 // and the fe80 checks use a masked comparison — a weakened full-value
 // `===` fails the assertion below.
    const src = readSrc("src/lib/agent/llm/route/ssrf-ipv6.ts");
    expect(src).toContain("a === 169 && b === 254");
    expect(src).toContain("(groups[0] & 0xffc0) === 0xfe80");
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
