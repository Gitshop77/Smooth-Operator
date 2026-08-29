import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";
import { buildStealthInitScript } from "@/server/browser/stealth";

// `new Function` compiles the source without running it, so a throw here is a
// pure syntax error — proving the init script is well-formed page-JS.
function compiles(source: string) {
  expect(() => new Function(source)).not.toThrow();
}

// Verifies the exact composition service.ts wires in `configurePageUnlocked`.
// The `evaluateOnNewDocument` call needs a live page; here we prove the source
// it injects is well-formed.
describe("stealth init-script composition (service wiring)", () => {
  it("balanced profile yields a non-empty, well-formed init script", () => {
    const source = buildStealthInitScript(buildFingerprintProfile({ profile: "balanced" }), { max: false });
    expect(source.length).toBeGreaterThan(0);
    expect(source.trimStart().startsWith("(function (")).toBe(true);
    compiles(source);
  });

  it("max profile yields a non-empty, well-formed init script", () => {
    const source = buildStealthInitScript(buildFingerprintProfile({ profile: "max" }), { max: true });
    expect(source.length).toBeGreaterThan(0);
    compiles(source);
  });
});
