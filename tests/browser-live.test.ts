import { createServer, type Server } from "node:http";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { BrowserService } from "@/server/browser/service";
import { findChromeExecutable } from "@/server/browser/discovery";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

const executablePath = process.env.SMOOTH_OPERATOR_TEST_BROWSER_EXECUTABLE ?? findChromeExecutable()?.path;
const LIVE_ACTION_TIMEOUT_MS = 60_000;
const LIVE_CONNECT_TIMEOUT_MS = 60_000;
const PROFILE_CLEANUP_ATTEMPTS = 24;
const PROFILE_CLEANUP_DELAY_MS = 250;
const PAGINATED_RAW_TEXT = "㍿漢字".repeat(3_000);

async function waitForChildExit(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", finish);
      child.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
    child.once("error", finish);
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The browser may have exited between the state check and kill.
  }
  await waitForChildExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The browser may have exited between the state check and kill.
    }
    await waitForChildExit(child, 5_000);
  }
}

async function removeDirectoryAfterBrowserExit(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROFILE_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: PROFILE_CLEANUP_DELAY_MS });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "EACCES", "EPERM", "ENOTEMPTY"].includes(code ?? "") || attempt + 1 >= PROFILE_CLEANUP_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, PROFILE_CLEANUP_DELAY_MS));
    }
  }
  throw lastError;
}

describe("live browser contract", () => {
  let fixture: Server;
  let baseUrl = "";
  let dataDir = "";
  let service: BrowserService;
  let uploadPaths: [string, string];
  const fixtureRequests: string[] = [];

  beforeAll(async () => {
    if (!executablePath) {
      throw new Error("No executable Chrome/Chromium installation was found. Install Chrome or set SMOOTH_OPERATOR_TEST_BROWSER_EXECUTABLE.");
    }
    fixture = createServer((request, response) => {
      fixtureRequests.push(request.url ?? "");
      if (request.url === "/frame") {
        response.end("<!doctype html><button id=frame-button>Frame action</button>");
        return;
      }
      if (request.url === "/private-form") {
        response.end(`<!doctype html><title>Private form</title><section id="container">
          <p>Public label</p><textarea id="private-text" aria-label="Notes">private-textarea-default-42</textarea>
          <input aria-label="Account" value="private-input-value-42">
          <script>window.fixtureSecret = 'private-script-source-42';</script></section>`);
        return;
      }
      if (request.url === "/page-slices") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><p>${PAGINATED_RAW_TEXT}</p>`);
        return;
      }
      if (request.url === "/scroll-container") {
        response.end(`<!doctype html><title>Scroll container</title>
          <textarea id="scrollbox" style="width:150px;height:95px;">${"scroll line ".repeat(600)}</textarea>`);
        return;
      }
      if (request.url === "/svg") {
        response.end(`<!doctype html><p id="status">ready</p>
          <svg width="160" height="80"><rect id="color-rect" x="4" y="4" width="40" height="40" fill="#ff0000" data-color="#ff0000" data-index="3" data-sides="left,right" data-result="win" data-key="shape" data-secret="do-not-return" aria-label="color target" onclick="document.querySelector('#status').textContent='rect-clicked'"></rect><text x="60" y="40" font-size="24" onclick="document.querySelector('#status').textContent='svg-clicked'">1</text></svg>`);
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
      if (request.url === "/resources") {
        response.end(`<!doctype html><title>Resources</title><p id=status>ready</p><link rel=stylesheet href=/allowed.css><img src=/blocked.png><script src=/blocked.js></script>`);
        return;
      }
      if (request.url === "/allowed.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end("body { color: rgb(1, 2, 3); }");
        return;
      }
      if (request.url === "/blocked.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("document.querySelector('#status').textContent='script-ran'");
        return;
      }
      if (request.url === "/blocked.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64"));
        return;
      }
      response.end(`<!doctype html>
        <title>Fixture</title>
        <h1>Fixture</h1>
        <button id=action-button onclick="document.querySelector('#status').textContent='clicked'">Action</button>
        <button id=alert-button onclick="alert('hello from fixture')">Alert</button>
        <input id=input value="" />
        <input id=file-input type=file multiple onchange="document.querySelector('#file-status').textContent=String(this.files.length)" />
        <p id=file-status>0</p>
        <input id=date-input type=date onchange="document.querySelector('#date-status').textContent=this.value" />
        <p id=date-status></p>
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
    dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-live-"));
    uploadPaths = [join(dataDir, "first.txt"), join(dataDir, "second.txt")];
    await Promise.all([writeFile(uploadPaths[0], "first", "utf8"), writeFile(uploadPaths[1], "second", "utf8")]);
    const base = testConfig();
    const config = testConfig({
      dataDir,
      browser: { ...base.browser, mode: "launch", executablePath, headless: true, actionTimeoutMs: LIVE_ACTION_TIMEOUT_MS, connectTimeoutMs: LIVE_CONNECT_TIMEOUT_MS, cdpTimeoutMs: LIVE_CONNECT_TIMEOUT_MS },
      security: { ...base.security, allowedDomains: ["127.0.0.1"], allowedFileRoots: [dataDir] },
    });
    service = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
  }, 30_000);

  afterAll(async () => {
    await service?.close();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (dataDir) {
      await removeDirectoryAfterBrowserExit(dataDir);
    }
  });

  it("omits private form values and script content from passive observations", async () => {
    await service.execute({ action: "navigate", url: `${baseUrl}/private-form` });
    const snapshot = await service.snapshot();
    const textarea = snapshot.interactive.find((element) => element.selector === "#private-text");
    expect(textarea).toBeDefined();
    await service.execute({ action: "click", ref: textarea!.ref, snapshotId: snapshot.snapshotId });
    const observations = [
      snapshot,
      await service.execute({ action: "extract" }),
      await service.execute({ action: "extract", selector: "#private-text" }),
      await service.execute({ action: "page_next" }),
      await service.execute({ action: "find_elements", selector: "#container, textarea, script" }),
      await service.execute({ action: "inspect_element", selector: "#container" }),
      await service.execute({ action: "accessibility_snapshot", interestingOnly: false }),
    ];
    for (const observation of observations) {
      expect(JSON.stringify(observation)).not.toMatch(/private-(?:textarea-default|input-value|script-source)-42/);
    }
    expect(await service.execute({ action: "search_page", query: "private-textarea-default-42" })).toMatchObject({ matches: [], totalMatches: 0 });
  });

  it("advances page offsets only for text represented after normalization and byte bounds", async () => {
    await service.execute({ action: "navigate", url: `${baseUrl}/page-slices` });
    const chunks: string[] = [];
    let offset = 0;
    let revision: number | undefined;
    let hasMore = true;
    for (let page = 0; hasMore && page < 10; page += 1) {
      const result = await service.execute(page === 0
        ? { action: "extract", offset, maxChars: 8_000 }
        : { action: "page_next", offset, revision, maxChars: 8_000 }) as { text: string; nextOffset: number; revision: number; hasMore: boolean };
      const match = /^<untrusted_[a-z0-9_]+>\n([\s\S]*)\n<\/untrusted_[a-z0-9_]+>$/.exec(result.text);
      expect(match).not.toBeNull();
      chunks.push(match![1]);
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
      revision = result.revision;
      hasMore = result.hasMore;
    }
    expect(hasMore).toBe(false);
    expect(offset).toBe(PAGINATED_RAW_TEXT.length);
    expect(chunks.join("")).toBe(PAGINATED_RAW_TEXT.normalize("NFKC"));
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
    expect(button?.ref).toBeTruthy();

    const clickedWithSnapshot = await service.execute({ action: "click", target: `ref:${button?.ref}`, snapshotId: snapshot.snapshotId, includeSnapshot: true }) as { snapshot?: { snapshotId?: string; interactive?: Array<{ selector?: string; ref?: string }> } };
    expect(clickedWithSnapshot.snapshot?.snapshotId).toBeTypeOf("string");
    const projectedInteractive = await service.execute({ action: "list_interactive" }) as Array<{ ref: string }>;
    expect(projectedInteractive.some((element) => element.ref === clickedWithSnapshot.snapshot?.interactive?.find((item) => item.selector === "#action-button")?.ref)).toBe(true);
    expect((await service.execute({ action: "extract", selector: "#status" }))).toMatchObject({ text: expect.stringContaining("clicked") });
    const freshInput = clickedWithSnapshot.snapshot?.interactive?.find((item) => item.selector === "#input");
    const inputResult = await service.execute({ action: "input", target: `ref:${freshInput?.ref}`, snapshotId: clickedWithSnapshot.snapshot?.snapshotId, text: "hello", verify: true });
    expect(inputResult).toMatchObject({ verified: true });
    expect(await service.execute({ action: "input", target: "#date-input", text: "2024-12-20", verify: true })).toMatchObject({ verified: true });
    expect(await service.execute({ action: "extract", selector: "#date-status" })).toMatchObject({ text: expect.stringContaining("2024-12-20") });
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
    const childAx = await service.execute({ action: "accessibility_snapshot", frameId: childFrameId, maxNodes: 100 }) as { nodes?: unknown[] };
    expect(JSON.stringify(childAx.nodes)).toContain("Frame action");
    await service.execute({ action: "navigate", url: `${baseUrl}/scroll-container` });
    await service.execute({ action: "click", target: "#scrollbox" });
    const focusedScroll = await service.execute({ action: "scroll", direction: "down", amount: 500 }) as { container?: string; y?: number };
    expect(focusedScroll).toMatchObject({ container: "element" });
    expect(focusedScroll.y).toBeGreaterThan(0);
    await service.execute({ action: "navigate", url: `${baseUrl}/svg` });
    const foundColorElements = await service.execute({ action: "find_elements", selector: "#color-rect" }) as Array<{ selector?: string; rect?: { width?: number; height?: number }; attributes?: Record<string, string> }>;
    expect(foundColorElements).toHaveLength(1);
    expect(foundColorElements[0]).toMatchObject({ selector: expect.stringContaining("#color-rect"), rect: { width: expect.any(Number), height: expect.any(Number) }, attributes: expect.objectContaining({ "data-color": expect.stringContaining("#ff0000"), "data-index": expect.stringContaining("3"), "data-sides": expect.stringContaining("left,right"), "data-result": expect.stringContaining("win"), "data-key": expect.stringContaining("shape"), "aria-label": expect.stringContaining("color target") }) });
    expect(foundColorElements[0]?.rect?.width).toBeGreaterThan(0);
    expect(foundColorElements[0]?.rect?.height).toBeGreaterThan(0);
    expect(foundColorElements[0]?.attributes).not.toHaveProperty("data-secret");
    expect(foundColorElements[0]?.attributes).not.toHaveProperty("onclick");
    expect(foundColorElements[0]?.attributes).toHaveProperty("fill");
    await service.execute({ action: "click", target: "1" });
    expect(await service.execute({ action: "extract", selector: "#status" })).toMatchObject({ text: expect.stringContaining("svg-clicked") });
    await service.execute({ action: "navigate", url: baseUrl });
    const inspected = await service.execute({ action: "inspect_element", selector: "#action-button", maxDepth: 1, maxChildren: 10 }) as Record<string, unknown>;
    expect(inspected).toMatchObject({ tag: expect.stringContaining("button"), computedStyles: expect.any(Object), pseudoElements: expect.any(Object), children: expect.any(Array) });
    expect(JSON.stringify(inspected)).not.toContain("onclick");
    expect(JSON.stringify(inspected)).not.toContain("querySelector('#status')");

    await service.execute({ action: "upload_file", selector: "#file-input", filePaths: uploadPaths });
    expect(await service.execute({ action: "extract", selector: "#file-status" })).toMatchObject({ text: expect.stringContaining("2") });

    await service.execute({ action: "set_cookie", cookieName: "fixture-cookie", cookieValue: "private-value", cookieSameSite: "Lax", url: baseUrl });
    const scopedCookies = await service.execute({ action: "get_cookies", url: baseUrl }) as Array<Record<string, unknown>>;
    expect(scopedCookies.some((cookie) => String(cookie.name).includes("fixture-cookie"))).toBe(true);
    expect(scopedCookies.every((cookie) => !("value" in cookie))).toBe(true);
    await service.execute({ action: "delete_cookies", cookieName: "fixture-cookie", url: baseUrl });
    const clearedCookies = await service.execute({ action: "get_cookies", url: baseUrl }) as Array<Record<string, unknown>>;
    expect(clearedCookies.some((cookie) => String(cookie.name).includes("fixture-cookie"))).toBe(false);

    await service.execute({ action: "enable_network_log" });
    await service.execute({ action: "clear_network_log" });
    await service.execute({ action: "resource_blocking", operation: "set", resourceTypes: ["image", "script"] });
    const requestStart = fixtureRequests.length;
    await service.execute({ action: "navigate", url: `${baseUrl}/resources` });
    expect(await service.execute({ action: "extract", selector: "#status" })).toMatchObject({ text: expect.stringContaining("ready") });
    const resourceRequests = fixtureRequests.slice(requestStart);
    expect(resourceRequests).toContain("/resources");
    expect(resourceRequests).toContain("/allowed.css");
    expect(resourceRequests).not.toContain("/blocked.js");
    expect(resourceRequests).not.toContain("/blocked.png");
    const networkSearch = await service.execute({ action: "search_network_log", url: "/resources", limit: 20 }) as { entries?: unknown[]; total?: number };
    expect(networkSearch.total).toBeGreaterThan(0);
    expect(networkSearch.entries).toEqual(expect.arrayContaining([expect.objectContaining({ method: "GET", status: 200 })]));
    await service.execute({ action: "resource_blocking", operation: "clear" });

    await service.execute({ action: "navigate", url: baseUrl });
    const jpeg = await service.execute({ action: "screenshot", format: "jpeg", quality: 60, maxBytes: 2_000_000 });
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", screenshotBase64: expect.any(String) });
    const scaled = await service.execute({ action: "screenshot", format: "png", maxDimension: 200, maxBytes: 2_000_000 }) as { screenshotBase64?: string };
    expect(scaled.screenshotBase64).toBeTypeOf("string");

    await service.execute({ action: "click", target: "#popup", newTab: true });
    expect((await service.listTabs()).some((tab) => tab.url.includes("/popup"))).toBe(true);
    await service.execute({ action: "navigate", url: `${baseUrl}/challenge` });
    expect(await service.execute({ action: "detect_challenge" })).toMatchObject({ status: "present" });
    expect(await service.execute({ action: "solve_challenge", includeScreenshot: true })).toMatchObject({
      solved: false,
      workflow: "ai_action_required",
      verification: "challenge_present",
      screenshotBase64: expect.any(String),
      refs: expect.any(Array),
    });
    expect(await service.execute({ action: "wait_for_human", timeoutMs: 500, pollMs: 250 })).toMatchObject({ status: "timed_out" });
    const abortController = new AbortController();
    const cancellableWait = service.execute({ action: "wait_for_human", timeoutMs: 10_000, pollMs: 250 }, abortController.signal);
    setTimeout(() => abortController.abort(), 100);
    await expect(cancellableWait).rejects.toMatchObject({ code: "CANCELLED" });
    await service.execute({ action: "navigate", url: baseUrl });
    const firstSlice = await service.execute({ action: "extract", selector: "body", offset: 0, maxChars: 40 }) as { nextOffset: number; revision: number; text: string };
    const secondSlice = await service.execute({ action: "page_next", offset: firstSlice.nextOffset, revision: firstSlice.revision, maxChars: 40 }) as { offset: number; nextOffset: number; revision: number; text: string };
    expect(secondSlice.offset).toBe(firstSlice.nextOffset);
    expect(secondSlice.nextOffset).toBeGreaterThan(secondSlice.offset);
    await service.execute({ action: "click", target: "#action-button" });
    await expect(service.execute({ action: "page_next", offset: secondSlice.nextOffset, revision: secondSlice.revision, maxChars: 100 })).rejects.toMatchObject({ code: "STALE_PAGE_SLICE" });
    const trailingBatch = await service.executeBatch([{ action: "wait", milliseconds: 0 }, { action: "get_page_info" }], { includeSnapshot: true }) as { results: unknown[]; snapshot?: { snapshotId?: string } };
    expect(trailingBatch.results).toHaveLength(2);
    expect(trailingBatch.snapshot?.snapshotId).toBeTypeOf("string");
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
    const managedDataDir = await mkdtemp(join(tmpdir(), "smooth-operator-managed-live-"));
    const profile = join(managedDataDir, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: managedDataDir,
      browser: { ...base.browser, mode: "managed", executablePath, headless: true, userDataDir: profile, actionTimeoutMs: LIVE_ACTION_TIMEOUT_MS, connectTimeoutMs: LIVE_CONNECT_TIMEOUT_MS, cdpTimeoutMs: LIVE_CONNECT_TIMEOUT_MS },
      security: { ...base.security, allowedDomains: ["127.0.0.1"], allowedFileRoots: [managedDataDir] },
    });
    const first = await ServerRuntime.create(config);
    let competing: ServerRuntime | undefined;
    let restarted: ServerRuntime | undefined;
    let firstProcess: ChildProcess | null | undefined;
    try {
      await expect(first.listTabs()).resolves.toEqual(expect.any(Array));
      await expect(access(join(profile, "DevToolsActivePort"))).resolves.toBeUndefined();
      competing = await ServerRuntime.create(config);
      await expect(competing.listTabs()).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
      await competing.close();
      competing = undefined;

      const internal = first.browser as unknown as { browser?: { disconnect(): Promise<void>; process(): ChildProcess | null } };
      firstProcess = internal.browser?.process() ?? undefined;
      await internal.browser?.disconnect();
      await first.close();
      restarted = await ServerRuntime.create(config);
      await expect(restarted.listTabs()).resolves.toEqual(expect.any(Array));
      expect(restarted.browser.connectionStatus()).toMatchObject({ connected: true, owned: true });
    } finally {
      await competing?.close().catch(() => undefined);
      await restarted?.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      // The disconnected `first` browser is no longer managed by the service,
      // so kill its child process directly to release the profile directory
      // before teardown removes it.
      await stopChild(firstProcess ?? undefined);
      await removeDirectoryAfterBrowserExit(managedDataDir);
    }
  }, 60_000);
});
