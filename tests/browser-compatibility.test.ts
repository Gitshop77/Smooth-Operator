import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadServerConfig } from "@/server/config";
import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";

describe("native browser compatibility profile", () => {
  it("uses one private persistent profile by default", () => {
    const dataDir = join(tmpdir(), "smooth-operator-compatibility");
    const config = loadServerConfig([], {
      SMOOTH_OPERATOR_DATA_DIR: dataDir,
      SMOOTH_OPERATOR_BROWSER_MODE: "launch",
      SMOOTH_OPERATOR_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    }, join(tmpdir(), "smooth-operator-compatibility-home"));

    expect(config.browser.userDataDir).toBe(join(dataDir, "browser"));
  });

  it("returns a fresh copy of the native launch defaults", () => {
    const first = nativeBrowserLaunchArgs();
    const second = nativeBrowserLaunchArgs();

    expect(first).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
    expect(first).not.toBe(second);
    first.push("--test-only");
    expect(nativeBrowserLaunchArgs()).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
  });

  it("does not include identity, security, or automation-evasion switches", () => {
    const args = nativeBrowserLaunchArgs();
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--ignore-certificate-errors");
    expect(args).not.toContain("--disable-web-security");
    expect(args).not.toContain("--no-sandbox");
  });

  it("appends the stealth baseline only when enabled", () => {
    const args = nativeBrowserLaunchArgs({ enabled: true });
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--lang=en-US");
    expect(args).not.toContain("--window-size=1920,1080");
  });

  it("appends GPU flags only when enabled and gpu is requested", () => {
    const enabledOnly = nativeBrowserLaunchArgs({ enabled: true });
    expect(enabledOnly).not.toContain("--use-angle=vulkan");
    expect(enabledOnly).not.toContain("--enable-vulkan");

    const withGpu = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(withGpu).toContain("--use-angle=vulkan");
    expect(withGpu).toContain("--enable-vulkan");
  });

  it("adds exactly one explicit viewport flag when configured", () => {
    const args = nativeBrowserLaunchArgs({ enabled: true, viewport: { width: 1366, height: 768 } });
    const viewportFlags = args.filter((a) => a.split("=")[0] === "--window-size");
    expect(viewportFlags).toEqual(["--window-size=1366,768"]);
  });

  it("returns a fresh array per call and never mutates the shared set", () => {
    const a = nativeBrowserLaunchArgs({ enabled: true });
    expect(a).not.toBe(NATIVE_BROWSER_LAUNCH_ARGS);
    expect(a).not.toBe(nativeBrowserLaunchArgs({ enabled: true }));

    a.push("--test-only");
    expect(nativeBrowserLaunchArgs({ enabled: true })).not.toContain("--test-only");
    expect([...NATIVE_BROWSER_LAUNCH_ARGS]).not.toContain("--test-only");
  });
});
