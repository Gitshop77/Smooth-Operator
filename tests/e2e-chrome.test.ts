/**
 * Browser-level e2e suite for the extension's content-script paths.
 *
 * Runs ONLY when E2E_CHROME=1 (optionally E2E_CHROME_PATH pointing at a
 * Chrome/Chromium binary). CI and plain `npm test` skip the whole block so the
 * suite stays green without a browser installed.
 *
 * The harness launches a real Chrome with the built unpacked extension
 * (`chrome-extension/`, produced by `npm run build:extension`) and covers the
 * three content-script surfaces:
 *   1. content-main.js (MAIN world, manifest-declared) injects the shadow
 *      piercer at document_start without breaking the page.
 *   2. content.js (isolated world, programmatic) is injectable through the
 *      same chrome.scripting path the background uses, and answers on its
 *      message channel (PING) — its window marker is isolated-world-only.
 *   3. The evaluate sandbox (new Function in the isolated world) round-trips
 *      a trivial expression through the EXECUTE_ACTIONS message channel.
 *
 * All waits are condition-based (waitForFunction / waitForTarget) — no raw
 * sleeps.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";

const E2E_CHROME = process.env.E2E_CHROME === "1";
const CHROME_PATH =
  process.env.E2E_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const EXTENSION_DIR = path.resolve(process.cwd(), "chrome-extension");
// The string NAME of the Symbol key content-main.js installs the piercer
// backdoor under. A Node-side Symbol value would NOT survive puppeteer's JSON
// serialization of evaluate/waitForFunction arguments (symbols are dropped,
// the page receives undefined), and functions referenced from an evaluated
// callback are not captured into the page — so every in-page callback
// re-creates the symbol itself via Symbol.for(key). The global symbol
// registry is shared within a world, so it resolves to the same value the
// MAIN-world content script installed.
const PIERCER_BACKDOOR_KEY = "__open_cowork_piercer_bd__";

const maybeDescribe = E2E_CHROME ? describe : describe.skip;

maybeDescribe("browser e2e (E2E_CHROME=1)", () => {
  let server: http.Server;
  let baseUrl: string;
  let browser: import("puppeteer-core").Browser | undefined;

  beforeAll(async () => {
    // content scripts match http://*/* only — serve a tiny local page.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><html><body>" +
          "<div id='app'><button id='normal-button'>click me</button></div>" +
          "<span id='click-count'>0</span>" +
          "</body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("e2e server failed to bind");
    baseUrl = `http://127.0.0.1:${address.port}/`;

    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
  }, 120_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The extension's background service-worker target. */
  async function serviceWorker(): Promise<import("puppeteer-core").WebWorker> {
    if (!browser) throw new Error("browser not launched");
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 20_000 },
    );
    const worker = await target.worker();
    if (!worker) throw new Error("extension service worker not ready");
    return worker;
  }

  /** The id of the running agent tab (the only tab the suite opens). */
  async function agentTabId(): Promise<number> {
    const worker = await serviceWorker();
    const tabId = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? null;
    });
    if (tabId === null || tabId === undefined) throw new Error("no agent tab id");
    return tabId;
  }

  test("content-main injects the shadow piercer at document_start", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    // The MAIN-world backdoor must be present on the shared window.
    await page.waitForFunction(
      (key) =>
        typeof (window as unknown as Record<PropertyKey, unknown>)[Symbol.for(key)] !== "undefined",
      { timeout: 10_000 },
      PIERCER_BACKDOOR_KEY,
    );
    const shape = await page.evaluate((key) => {
      const bd = (window as unknown as Record<
        PropertyKey,
        { getShadowRoot?: unknown; pierceShadowRoots?: unknown }
      >)[Symbol.for(key)];
      return {
        hasGetShadowRoot: typeof bd?.getShadowRoot === "function",
        hasPierce: typeof bd?.pierceShadowRoots === "function",
      };
    }, PIERCER_BACKDOOR_KEY);
    expect(shape.hasGetShadowRoot).toBe(true);
    expect(shape.hasPierce).toBe(true);
    await page.close();
  });

  test("the page stays fully functional with the piercer installed", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForFunction(
      (key) =>
        typeof (window as unknown as Record<PropertyKey, unknown>)[Symbol.for(key)] !== "undefined",
      { timeout: 10_000 },
      PIERCER_BACKDOOR_KEY,
    );

    // Attach a CLOSED shadow root after load and verify the piercer captured
    // it while the page keeps behaving normally.
    const captured = await page.evaluate((key) => {
      const host = document.createElement("div");
      host.id = "shadow-host";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = "<button id='inner'>inner</button>";
      document.body.appendChild(host);
      const bd = (window as unknown as Record<
        PropertyKey,
        { pierceShadowRoots?: (root: Element | Document | ShadowRoot) => Element[] }
      >)[Symbol.for(key)];
      return {
        // pierceShadowRoots returns the flat tree — the host's closed root's
        // inner button must be reachable through it.
        pierced: (bd?.pierceShadowRoots?.(document.body) ?? []).some(
          (el) => el.id === "inner",
        ),
        pageAlive:
          document.body !== null &&
          document.getElementById("app")?.textContent === "click me",
      };
    }, PIERCER_BACKDOOR_KEY);
    expect(captured.pierced).toBe(true);
    expect(captured.pageAlive).toBe(true);

    // Ordinary page interactivity is unaffected: a real click still lands.
    await page.click("#normal-button");
    await page.waitForFunction(
      () => document.getElementById("click-count")?.textContent === "1",
      { timeout: 10_000 },
    );
    await page.close();
  });

  test("content.js programmatic injection responds on its message channel", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const worker = await serviceWorker();
    const tabId = await agentTabId();

    const injected = await worker.evaluate(async (id) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
        return true;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }, tabId);
    expect(injected).toBe(true);

    // content.ts runs in the ISOLATED world, so its `__openCoworkInjected`
    // window marker is invisible to the page's MAIN world. Prove the injected
    // script is live through its message handler instead — the same PING the
    // background uses to poll for injection.
    const pong = (await worker.evaluate(async (id) => {
      try {
        return await chrome.tabs.sendMessage(id, { type: "PING" });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }, tabId)) as { ok?: boolean };
    expect(pong?.ok).toBe(true);
    await page.close();
  });

  test("evaluate sandbox round-trips a trivial expression", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const worker = await serviceWorker();
    const tabId = await agentTabId();
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    }, tabId);
    // Same isolated-world liveness check as the injection test: the content
    // script must be listening before EXECUTE_ACTIONS can round-trip.
    const pong = (await worker.evaluate(async (id) => {
      try {
        return await chrome.tabs.sendMessage(id, { type: "PING" });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }, tabId)) as { ok?: boolean };
    expect(pong?.ok).toBe(true);

    // evaluate is fail-closed without a domain allowlist; grant one for the
    // local origin so the sandbox itself is what runs.
    const res = (await worker.evaluate(async (id) => {
      return chrome.tabs.sendMessage(id, {
        type: "EXECUTE_ACTIONS",
        domainConfig: { allowedDomains: ["127.0.0.1"] },
        actions: [{ type: "evaluate", code: "1 + 1" }],
      });
    }, tabId)) as { ok?: boolean; results?: Array<{ success?: boolean; extractedContent?: string; message?: string }> };

    expect(res?.ok).toBe(true);
    expect(res?.results?.[0]?.success).toBe(true);
    expect(res?.results?.[0]?.extractedContent).toBe("2");
    await page.close();
  });
});
