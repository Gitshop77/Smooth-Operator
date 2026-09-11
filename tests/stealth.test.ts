import { describe, expect, it } from "vitest";

import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";
import { classifyChallenge } from "@/server/browser/challenges";

const IDENTITY_LEAKS = [
  "webdriver",
  "userAgent",
  "user-agent",
  "HeadlessChrome",
  "WebGL",
  "canvas",
  "clientHint",
  "client-hint",
  "navigator.platform",
  "AutomationControlled",
];

describe("browser identity-preserving compatibility", () => {
  it("does not add identity or automation-evasion launch flags", () => {
    const headed = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(headed.join(" ")).not.toMatch(/HeadlessChrome/i);
    expect(headed.some((flag) => flag.startsWith("--user-agent"))).toBe(false);
    expect(headed).not.toContain("--disable-blink-features=AutomationControlled");
    expect(headed).not.toContain("--ignore-certificate-errors");
    expect(headed).not.toContain("--disable-web-security");
    expect(headed).not.toContain("--no-sandbox");
    expect(headed).toContain("--use-angle=vulkan");
    expect(headed).toContain("--enable-vulkan");
    for (const leak of IDENTITY_LEAKS) {
      expect(headed.join(" ").toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("keeps launch arrays fresh and applies only an explicit viewport", () => {
    const result = nativeBrowserLaunchArgs({ enabled: false, viewport: { width: 1_366, height: 768 } });
    expect(result.filter((value) => value.startsWith("--window-size"))).toEqual(["--window-size=1366,768"]);
    expect(nativeBrowserLaunchArgs()).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
    expect(nativeBrowserLaunchArgs()).not.toBe(nativeBrowserLaunchArgs());
  });

  it("does not change launch identity between balanced and max profiles", () => {
    const balanced = nativeBrowserLaunchArgs({ gpu: true, viewport: { width: 800, height: 600 } });
    const max = nativeBrowserLaunchArgs({ gpu: true, viewport: { width: 800, height: 600 } });
    expect(balanced).toEqual(max);
    expect(JSON.stringify(balanced)).not.toMatch(/Mozilla|Win32|WebGL|canvas|webdriver/i);
  });

  it("reports challenge success only from an explicit absent classification", () => {
    const absent = classifyChallenge({ title: "Example", text: "Hello", html: "<p>Hello</p>" });
    expect(absent.status).toBe("absent");
    expect(absent.detected).toBe(false);
    const present = classifyChallenge({ title: "Just a moment...", text: "Checking your browser before you proceed." });
    expect(present.status).not.toBe("absent");
  });
});
