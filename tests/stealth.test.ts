import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";
import {
  buildStealthInitScript,
  buildStealthLaunchArgs,
  STEALTH_BASELINE_ARGS,
} from "@/server/browser/stealth";

// `new Function` compiles the source without running it, so a throw here is a
// pure syntax error — proving the init script is well-formed page-JS.
function compiles(source: string) {
  expect(() => new Function(source)).not.toThrow();
}

const MARKERS = ["webdriver", "Google Inc.", "HeadlessChrome", "'chrome'", "permissions"];

describe("buildStealthLaunchArgs", () => {
  const profile = buildFingerprintProfile({ version: 145, language: "de-DE" });

  it("returns a fresh array without mutating the shared baseline", () => {
    const before = [...STEALTH_BASELINE_ARGS];
    const returned = buildStealthLaunchArgs(profile, false);
    expect(returned).not.toBe(STEALTH_BASELINE_ARGS);
    // Mutating the returned array must not affect the shared baseline.
    const mutable = [...returned];
    mutable.push("--test-only");
    expect([...STEALTH_BASELINE_ARGS]).toEqual(before);
    expect([...returned]).not.toContain("--test-only");
  });

  it("interpolates --lang and --window-size from the profile", () => {
    const result = buildStealthLaunchArgs(profile, false);
    expect(result).toContain("--disable-blink-features=AutomationControlled");
    expect(result).toContain(`--lang=${profile.languages[0]}`);
    expect(result).toContain(`--window-size=${profile.viewport.width},${profile.viewport.height}`);
  });

  it("appends GPU flags only when gpu is true", () => {
    const without = buildStealthLaunchArgs(profile, false);
    const withGpu = buildStealthLaunchArgs(profile, true);
    expect(without).not.toContain("--use-angle=vulkan");
    expect(without).not.toContain("--enable-vulkan");
    expect(withGpu).toContain("--use-angle=vulkan");
    expect(withGpu).toContain("--enable-vulkan");
    expect(withGpu.length).toBe(without.length + 2);
  });

  it("produces a clean, deduped set", () => {
    const result = buildStealthLaunchArgs(profile, true);
    expect(result.filter((arg) => arg.startsWith("--lang"))).toHaveLength(1);
    expect(result.filter((arg) => arg.startsWith("--window-size"))).toHaveLength(1);
    expect(result.filter((arg) => arg.startsWith("--disable-blink-features"))).toHaveLength(1);
  });
});

describe("buildStealthInitScript — balanced", () => {
  const profile = buildFingerprintProfile({ version: 145, language: "de-DE" });
  const source = buildStealthInitScript(profile, {});

  it("returns a non-empty string", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is syntactically valid page-JS", () => {
    compiles(source);
  });

  it("deletes navigator.webdriver", () => {
    expect(source).toContain("webdriver");
    expect(source).toContain("delete");
    expect(source).toContain("Object.getPrototypeOf(navigator)");
  });

  it("sets navigator.languages to the profile languages", () => {
    expect(source).toContain(JSON.stringify(profile.languages));
  });

  it("forces the Google Inc. vendor", () => {
    expect(source).toContain("Google Inc.");
  });

  it("strips the HeadlessChrome brand", () => {
    expect(source).toContain("HeadlessChrome");
    expect(source).toContain("indexOf('Headless')");
  });

  it("fabricates window.chrome", () => {
    expect(source).toContain("'chrome'");
    expect(source).toContain("runtime");
    expect(source).toContain("defineProperty(window");
  });

  it("guards permissions.query against insecure origins", () => {
    expect(source).toContain("permissions");
    expect(source).toContain("PermissionStatus");
    expect(source).toContain("notifications");
  });
});

describe("buildStealthInitScript — max", () => {
  const profile = buildFingerprintProfile({ profile: "max", version: 145, language: "de-DE" });
  const balanced = buildStealthInitScript(profile, {});
  const source = buildStealthInitScript(profile, { max: true });

  it("keeps every balanced marker", () => {
    for (const marker of MARKERS) {
      expect(source).toContain(marker);
    }
    expect(source).toContain(JSON.stringify(profile.languages));
    expect(balanced).not.toContain("hardwareConcurrency");
  });

  it("adds the max markers", () => {
    expect(source).toContain("hardwareConcurrency");
    expect(source).toContain("deviceMemory");
    expect(source).toContain("plugins");
    expect(source).toContain("mimeTypes");
    expect(source).toContain("canPlayType");
    expect(source).toContain("contentWindow");
    expect(source).toContain("Intl");
    expect(source).toContain("timeZone");
  });

  it("is syntactically valid page-JS", () => {
    compiles(source);
  });
});

describe("buildStealthInitScript — coherence & determinism", () => {
  it("interpolates the profile (languages + brands), not drift", () => {
    const profile = buildFingerprintProfile({ version: 145, language: "de-DE" });
    const source = buildStealthInitScript(profile, {});
    expect(source).toContain(JSON.stringify(profile.languages));
    expect(source).toContain(JSON.stringify(profile.brands));
    expect(source).toContain('"145"'); // brand versions derived from profile.version
  });

  it("is deterministic for identical inputs", () => {
    const profile = buildFingerprintProfile({ version: 130, language: "ja-JP" });
    expect(buildStealthInitScript(profile, {})).toBe(buildStealthInitScript(profile, {}));
    expect(buildStealthInitScript(profile, { max: true })).toBe(buildStealthInitScript(profile, { max: true }));
  });

  it("never throws compiling balanced or max", () => {
    const balanced = buildFingerprintProfile();
    const max = buildFingerprintProfile({ profile: "max" });
    compiles(buildStealthInitScript(balanced, {}));
    compiles(buildStealthInitScript(max, { max: true }));
  });
});
