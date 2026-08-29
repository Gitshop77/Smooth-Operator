import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";

describe("browser compatibility dimensions", () => {
  it("is deterministic and uses a bounded default viewport", () => {
    expect(buildFingerprintProfile()).toEqual(buildFingerprintProfile());
    expect(buildFingerprintProfile().viewport).toEqual({ width: 1_920, height: 1_080 });
  });

  it("honors a valid explicit viewport", () => {
    expect(buildFingerprintProfile({ viewport: { width: 1_366.9, height: 768.2 } }).viewport).toEqual({ width: 1_366, height: 768 });
  });

  it("falls back safely for invalid dimensions", () => {
    expect(buildFingerprintProfile({ viewport: { width: 0, height: Number.NaN } }).viewport).toEqual({ width: 1_920, height: 1_080 });
  });

  it("does not expose replacement identity or hardware claims", () => {
    const profile = buildFingerprintProfile({ profile: "max" });
    expect(Object.keys(profile)).toEqual(["viewport"]);
    expect(JSON.stringify(profile)).not.toMatch(/userAgent|platform|hardwareConcurrency|deviceMemory|languages|client/i);
  });
});
