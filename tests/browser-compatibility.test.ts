import { describe, expect, it } from "vitest";

import { loadServerConfig } from "@/server/config";
import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";

describe("native browser compatibility profile", () => {
  it("uses one private persistent profile by default", () => {
    const config = loadServerConfig([], {
      OPEN_COWORK_DATA_DIR: "/tmp/open-cowork-compatibility",
      OPEN_COWORK_BROWSER_MODE: "launch",
      OPEN_COWORK_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    });

    expect(config.browser.userDataDir).toBe("/tmp/open-cowork-compatibility/browser");
  });

  it("returns a fresh copy of the audited launch defaults", () => {
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
});
