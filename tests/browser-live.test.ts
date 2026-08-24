import { createServer, type Server } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { BrowserService } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

const executablePath = process.env.OPEN_COWORK_TEST_BROWSER_EXECUTABLE;
const describeLive = executablePath ? describe : describe.skip;

describeLive("live browser contract", () => {
  let fixture: Server;
  let baseUrl = "";
  let dataDir = "";
  let service: BrowserService;

  beforeAll(async () => {
    fixture = createServer((request, response) => {
      if (request.url === "/frame") {
        response.end("<!doctype html><button id=frame-button>Frame action</button>");
        return;
      }
      if (request.url === "/download") {
        response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=fixture.txt" });
        response.end("downloaded");
        return;
      }
      if (request.url === "/popup") {
        response.end("<!doctype html><title>Popup</title><p>popup content</p>");
        return;
      }
      if (request.url === "/challenge") {
        response.end("<!doctype html><title>Checking your browser</title><div class=cf-turnstile>challenge</div>");
        return;
      }
      response.end(`<!doctype html>
        <title>Fixture</title>
        <h1>Fixture</h1>
        <button id=action-button onclick="document.querySelector('#status').textContent='clicked'">Action</button>
        <button id=alert-button onclick="alert('hello from fixture')">Alert</button>
        <input id=input value="" />
        <p id=status>ready</p>
        <a id=popup href="/popup" target="_blank">Open popup</a>
        <a id=download href="/download">Download</a>
        <div id=shadow-host></div>
        <script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow</button>'</script>
        <iframe src="/frame"></iframe>`);
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture did not expose a TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    dataDir = await mkdtemp(join(tmpdir(), "open-cowork-live-"));
    const config = testConfig({
      dataDir,
      browser: { ...testConfig().browser, mode: "launch", executablePath, headless: true },
      security: { ...testConfig().security, allowedDomains: ["127.0.0.1"], allowedFileRoots: [dataDir] },
    });
    service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
  }, 30_000);

  afterAll(async () => {
    await service?.close();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("supports state-first refs, frames, popups, accessibility, screenshots, challenges, and downloads", async () => {
    const navigation = await service.execute({ action: "navigate", url: baseUrl });
    expect(navigation).toMatchObject({ url: expect.stringContaining(baseUrl) });

    const snapshot = await service.snapshot({ includeFrames: "metadata", maxChars: 20_000 });
    expect(snapshot.snapshotId).toBeTypeOf("string");
    expect(snapshot.readyState).toBe("complete");
    const childFrameId = (snapshot.frames?.find((frame) => (frame as { frameId?: string }).frameId !== "main") as { frameId?: string } | undefined)?.frameId;
    expect(childFrameId).toBeTypeOf("string");
    const button = snapshot.interactive.find((element) => element.selector === "#action-button");
    const input = snapshot.interactive.find((element) => element.selector === "#input");
    expect(button?.ref).toBeTruthy();
    expect(input?.ref).toBeTruthy();

    await service.execute({ action: "click", target: `ref:${button?.ref}`, snapshotId: snapshot.snapshotId });
    expect((await service.execute({ action: "extract", selector: "#status" }))).toMatchObject({ text: expect.stringContaining("clicked") });
    const inputResult = await service.execute({ action: "input", target: `ref:${input?.ref}`, snapshotId: snapshot.snapshotId, text: "hello", verify: true });
    expect(inputResult).toMatchObject({ verified: true });
    expect(await service.execute({ action: "find_elements", selector: "pierce/#shadow-button" })).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "button" })]));
    await service.execute({ action: "click", target: "pierce/#shadow-button" });
    await service.execute({ action: "click", target: "#alert-button" });
    expect(await service.execute({ action: "alert_get_text" })).toMatchObject({ open: true, type: "alert", text: expect.stringContaining("hello from fixture") });
    await service.execute({ action: "alert_accept" });
    expect(await service.execute({ action: "alert_get_text" })).toMatchObject({ open: false });

    const frameSnapshot = await service.snapshot({ frameId: childFrameId, maxChars: 5_000 });
    const frameButton = frameSnapshot.interactive.find((element) => element.selector === "#frame-button");
    expect(frameButton?.ref).toBeTruthy();
    await service.execute({ action: "click", frameId: childFrameId, target: `ref:${frameButton?.ref}`, snapshotId: frameSnapshot.snapshotId });

    const ax = await service.execute({ action: "accessibility_snapshot", maxNodes: 100 });
    expect(ax).toMatchObject({ pageId: snapshot.pageId, nodes: expect.any(Array) });
    const jpeg = await service.execute({ action: "screenshot", format: "jpeg", quality: 60, maxBytes: 2_000_000 });
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", screenshotBase64: expect.any(String) });
    const scaled = await service.execute({ action: "screenshot", format: "png", maxDimension: 200, maxBytes: 2_000_000 }) as { screenshotBase64?: string };
    expect(scaled.screenshotBase64).toBeTypeOf("string");

    await service.execute({ action: "click", target: "#popup", newTab: true });
    expect((await service.listTabs()).some((tab) => tab.url.includes("/popup"))).toBe(true);
    await service.execute({ action: "navigate", url: `${baseUrl}/challenge` });
    expect(await service.execute({ action: "detect_challenge" })).toMatchObject({ status: "present", bypassAttempted: false });
    await expect(service.execute({ action: "click", target: "#action-button" })).rejects.toMatchObject({ code: "CHALLENGE_REQUIRES_HUMAN" });
    expect(await service.execute({ action: "wait_for_human", timeoutMs: 500, pollMs: 250 })).toMatchObject({ status: "timed_out" });
    const abortController = new AbortController();
    const cancellableWait = service.execute({ action: "wait_for_human", timeoutMs: 10_000, pollMs: 250 }, abortController.signal);
    setTimeout(() => abortController.abort(), 100);
    await expect(cancellableWait).rejects.toMatchObject({ code: "CANCELLED" });
    await service.execute({ action: "navigate", url: baseUrl });
    await service.execute({ action: "click", target: "#download" });
    const deadline = Date.now() + 5_000;
    let downloads: unknown = [];
    while (Date.now() < deadline) {
      downloads = await service.execute({ action: "list_downloads" });
      if (Array.isArray(downloads) && downloads.some((entry) => (
        entry && typeof entry === "object" && "name" in entry && typeof entry.name === "string" && entry.name.includes("fixture.txt") && "status" in entry && entry.status === "complete"
      ))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(downloads).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("fixture.txt"), status: "complete" })]));
  }, 60_000);

  it("launches managed Chrome, protects its profile, and reattaches after restart", async () => {
    const managedDataDir = await mkdtemp(join(tmpdir(), "open-cowork-managed-live-"));
    const profile = join(managedDataDir, "browser");
    const config = testConfig({
      dataDir: managedDataDir,
      browser: { ...testConfig().browser, mode: "managed", executablePath, headless: true, userDataDir: profile },
      security: { ...testConfig().security, allowedDomains: ["127.0.0.1"], allowedFileRoots: [managedDataDir] },
    });
    const first = await ServerRuntime.create(config);
    let restarted: ServerRuntime | undefined;
    try {
      await expect(first.listTabs()).resolves.toEqual(expect.any(Array));
      await expect(access(join(profile, "DevToolsActivePort"))).resolves.toBeUndefined();
      await expect(ServerRuntime.create(config)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });

      const internal = first.browser as unknown as { browser?: { disconnect(): Promise<void> } };
      await internal.browser?.disconnect();
      await first.close();
      restarted = await ServerRuntime.create(config);
      await expect(restarted.listTabs()).resolves.toEqual(expect.any(Array));
      expect(restarted.browser.connectionStatus()).toMatchObject({ connected: true, owned: true });
    } finally {
      await restarted?.close();
      await first.close();
      await rm(managedDataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
