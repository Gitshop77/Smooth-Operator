import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { nativeBrowserLaunchArgs } from "@/server/browser/compatibility";
import { BrowserService } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";

import { testConfig } from "./helpers";

const IDENTITY_LEAKS = [
  "webdriver",
  "userAgent",
  "HeadlessChrome",
  "WebGL",
  "canvas",
  "clientHint",
  "navigator.platform",
  "AutomationControlled",
];

describe("native identity (no page init-script injection)", () => {
  it("does not inject a viewport or identity page script when stealth is enabled", async () => {
    const config = testConfig({
      stealth: { enabled: true, profile: "max", gpu: false, behaviorEnabled: false },
      browser: { ...testConfig().browser, viewport: { width: 1366, height: 768 } },
    });
    const service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    const evaluateOnNewDocument = vi.fn(async () => undefined);
    const page = new EventEmitter() as EventEmitter & {
      isClosed(): boolean;
      setDefaultTimeout(timeout: number): void;
      setDefaultNavigationTimeout(timeout: number): void;
      setRequestInterception(enabled: boolean): Promise<void>;
      setViewport(viewport: unknown): Promise<void>;
      createCDPSession(): Promise<{ send(method: string, params?: unknown): Promise<unknown>; detach(): Promise<void> }>;
      evaluateOnNewDocument(source: string): Promise<void>;
    };
    page.isClosed = () => false;
    page.setDefaultTimeout = () => undefined;
    page.setDefaultNavigationTimeout = () => undefined;
    page.setRequestInterception = async () => undefined;
    page.setViewport = async () => undefined;
    page.createCDPSession = async () => ({ send: async () => undefined, detach: async () => undefined });
    page.evaluateOnNewDocument = evaluateOnNewDocument;
    const internal = service as unknown as {
      stateFor(page: unknown): { downloadConfigured: boolean };
      configurePage(state: unknown, signal?: AbortSignal): Promise<void>;
    };
    const state = internal.stateFor(page);
    state.downloadConfigured = true;

    await internal.configurePage(state);

    expect(evaluateOnNewDocument).not.toHaveBeenCalled();
    await service.close();
  });

  it("keeps balanced and max launch identity identical and unpatched", () => {
    const balanced = nativeBrowserLaunchArgs({ gpu: true, viewport: { width: 800, height: 600 } });
    const max = nativeBrowserLaunchArgs({ gpu: true, viewport: { width: 800, height: 600 } });
    expect(balanced).toEqual(max);
    const joined = balanced.join(" ");
    for (const leak of IDENTITY_LEAKS) {
      expect(joined.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    expect(joined).not.toMatch(/webdriver\s*=\s*false/);
    expect(joined).not.toContain("--disable-blink-features=AutomationControlled");
  });
});
