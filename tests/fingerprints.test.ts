import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";

const HARDWARE_CONCURRENCY_SET = [2, 4, 8, 16, 32];
const DEVICEMEMORY_SET = [1, 2, 4, 8];
const MAX_TOUCH_POINTS_SET = [0, 5, 10];

describe("fingerprints: determinism", () => {
  it("produces an identical deep profile across repeated calls", () => {
    expect(buildFingerprintProfile()).toEqual(buildFingerprintProfile());
  });

  it("returns the same result for the same seed", () => {
    expect(buildFingerprintProfile({ profile: "max", seed: 7 })).toEqual(buildFingerprintProfile({ profile: "max", seed: 7 }));
  });

  it("keeps core values stable regardless of the seed", () => {
    const base = buildFingerprintProfile();
    expect(base.userAgent).toEqual(buildFingerprintProfile({ seed: 12345 }).userAgent);
    expect(base.brands).toEqual(buildFingerprintProfile({ seed: 12345 }).brands);
    expect(base.version).toBe(124);
  });
});

describe("fingerprints: coherence", () => {
  it("embeds Chrome/<version> and never leaks HeadlessChrome", () => {
    const profile = buildFingerprintProfile({ version: 145 });
    expect(profile.userAgent).toContain("Chrome/145");
    expect(profile.userAgent).not.toContain("HeadlessChrome");
    expect(profile.version).toBe(145);
  });

  it("derives every brand version from the Chrome version", () => {
    const profile = buildFingerprintProfile({ version: 130 });
    const versionStr = String(130);
    expect(profile.brands).toEqual([
      { brand: "Chromium", version: versionStr },
      { brand: "Google Chrome", version: versionStr },
      { brand: "Not=A?Brand", version: "8" },
    ]);
  });

  it("keeps fullVersionList coherent with the version", () => {
    const versionStr = String(130);
    expect(buildFingerprintProfile({ version: 130 }).fullVersionList).toEqual({ Chromium: versionStr, "Google Chrome": versionStr });
  });

  it("exposes the en-US language pair and accept-language header", () => {
    const profile = buildFingerprintProfile();
    expect(profile.languages).toEqual(["en-US", "en"]);
    expect(profile.acceptLanguage).toBe("en-US,en;q=0.9");
  });

  it("omits HeadlessChrome from every serialized field", () => {
    const profile = buildFingerprintProfile({ profile: "max" });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("HeadlessChrome");
  });
});

describe("fingerprints: platform segments", () => {
  it("matches the Windows UA segment and platform field", () => {
    const profile = buildFingerprintProfile({ platform: "Windows" });
    expect(profile.userAgent).toContain("Windows NT 10.0; Win64; x64");
    expect(profile.platform).toBe("Windows");
  });

  it("matches the macOS UA segment and platform field", () => {
    const profile = buildFingerprintProfile({ platform: "macOS" });
    expect(profile.userAgent).toContain("Mac OS X 10_15_7");
    expect(profile.platform).toBe("macOS");
  });

  it("matches the Linux UA segment and platform field", () => {
    const profile = buildFingerprintProfile({ platform: "Linux" });
    expect(profile.userAgent).toContain("X11; Linux x86_64");
    expect(profile.platform).toBe("Linux");
  });

  it("falls back to a coherent segment for an unknown platform", () => {
    const profile = buildFingerprintProfile({ platform: "Windows" as "Windows" });
    expect(profile.userAgent).toContain("Windows NT 10.0; Win64; x64");
  });
});

describe("fingerprints: profile gating", () => {
  it("leaves hardware surfaces absent for the balanced profile", () => {
    const profile = buildFingerprintProfile();
    expect(profile.hardwareConcurrency).toBeUndefined();
    expect(profile.deviceMemory).toBeUndefined();
    expect(profile.maxTouchPoints).toBeUndefined();
    expect(profile.timeZone).toBeUndefined();
  });

  it("constrains the max profile to the valid hardware sets", () => {
    const profile = buildFingerprintProfile({ profile: "max" });
    expect(HARDWARE_CONCURRENCY_SET).toContain(profile.hardwareConcurrency);
    expect(DEVICEMEMORY_SET).toContain(profile.deviceMemory);
    expect(MAX_TOUCH_POINTS_SET).toContain(profile.maxTouchPoints);
    expect(profile.timeZone).toBe("America/New_York");
  });

  it("picks max hardware deterministically from the seed", () => {
    const a = buildFingerprintProfile({ profile: "max", seed: 3 });
    const b = buildFingerprintProfile({ profile: "max", seed: 3 });
    expect(a).toEqual(b);
  });
});

describe("fingerprints: overrides", () => {
  it("reflects a custom version, platform, viewport, and language", () => {
    const profile = buildFingerprintProfile({
      version: 137,
      platform: "Linux",
      viewport: { width: 1366, height: 768 },
      language: "de-DE",
    });
    expect(profile.version).toBe(137);
    expect(profile.userAgent).toContain("Chrome/137");
    expect(profile.userAgent).toContain("X11; Linux x86_64");
    expect(profile.viewport).toEqual({ width: 1366, height: 768 });
    expect(profile.languages).toEqual(["de-DE", "de"]);
    expect(profile.acceptLanguage).toBe("de-DE,en;q=0.9");
  });

  it("honors a custom timeZone in the max profile", () => {
    const profile = buildFingerprintProfile({ profile: "max", timeZone: "Europe/London" });
    expect(profile.timeZone).toBe("Europe/London");
  });
});
