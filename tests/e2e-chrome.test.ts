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
 *   3. The legacy evaluate sandbox fails closed under the MV3 extension CSP;
 *      the package reports the incompatibility instead of weakening CSP.
 *
 * All waits are condition-based (waitForFunction / waitForTarget) — no raw
 * sleeps.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

const E2E_CHROME = process.env.E2E_CHROME === "1";
const CHROME_PATH =
  process.env.E2E_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const EXTENSION_DIR = path.resolve(process.cwd(), "chrome-extension");
const E2E_ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR;
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
  let providerServer: http.Server;
  let baseUrl: string;
  let browser: import("puppeteer-core").Browser | undefined;
  let extensionApiPage: import("puppeteer-core").Page | undefined;

  beforeAll(async () => {
    // Puppeteer's page.screenshot({ path }) fails with ENOENT when the target
    // directory does not exist — create it up front so E2E_ARTIFACT_DIR is
    // honored without requiring the caller to pre-create the directory.
    if (E2E_ARTIFACT_DIR) fs.mkdirSync(E2E_ARTIFACT_DIR, { recursive: true });
    // content scripts match http://*/* only — serve a tiny local page.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><html><body>" +
          "<div id='app'>" +
          "<button id='wait-entry-button' onclick=\"setTimeout(()=>document.getElementById('wait-entered').textContent='1',1500)\">enter wait</button>" +
          "<button id='normal-button' onclick=\"document.getElementById('click-count').textContent='1'\">click me</button>" +
          "</div>" +
          "<span id='wait-entered'>0</span>" +
          "<span id='click-count'>0</span>" +
          "</body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("e2e server failed to bind");
    baseUrl = `http://127.0.0.1:${address.port}/`;

    // A normal Ollama-compatible endpoint that deliberately holds generation
    // open. It lets the packaged RUN/STOP journey exercise cancellation
    // without external credentials or a production-only test provider.
    providerServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": waiting for packaged STOP\n\n");
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(11434, "127.0.0.1", () => {
        providerServer.off("error", reject);
        resolve();
      });
    });

    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      // Puppeteer adds --disable-extensions by default. Chrome-for-Testing
      // still exposes declarative content scripts with that flag, but its
      // extension service worker loses the chrome.* API surface entirely.
      // We explicitly load one unpacked extension below, so remove only that
      // conflicting default rather than broadening the browser launch.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    const id = await extensionId();
    extensionApiPage = await browser.newPage();
    await extensionApiPage.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  }, 120_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (providerServer) {
      providerServer.closeAllConnections?.();
      await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    }
  }, 30_000);

  /** The extension's background service-worker target. */
  async function serviceWorkerTarget(): Promise<import("puppeteer-core").Target> {
    if (!browser) throw new Error("browser not launched");
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 20_000 },
    );
    return target;
  }

  async function extensionId(): Promise<string> {
    const target = await serviceWorkerTarget();
    return new URL(target.url()).host;
  }

  function apiPage(): import("puppeteer-core").Page {
    if (!extensionApiPage) throw new Error("extension API page not ready");
    return extensionApiPage;
  }

  async function openPanel(width: number): Promise<import("puppeteer-core").Page> {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${await extensionId()}/sidepanel.html`, { waitUntil: "load" });
    return page;
  }

  async function sendTaskWithoutActivatingPanel(
    panel: import("puppeteer-core").Page,
    agentPage: import("puppeteer-core").Page,
    task: string,
  ): Promise<void> {
    await panel.bringToFront();
    await panel.click("#messageInput");
    await panel.type("#messageInput", task);
    await panel.waitForFunction(
      () => !(document.querySelector("#sendBtn") as HTMLButtonElement)?.disabled,
      { polling: 50, timeout: 5_000 },
    );
    // A real Chrome side panel does not replace the active web tab. A regular
    // extension page is used by headless Chrome as the panel surface, so run
    // its public Send click through Runtime.evaluate after restoring the web
    // tab as active.
    await agentPage.bringToFront();
    await panel.evaluate(() => (document.querySelector("#sendBtn") as HTMLButtonElement).click());
  }

  async function status(): Promise<{ running?: boolean; snapshot?: Record<string, unknown> | null }> {
    return apiPage().evaluate(async () => chrome.runtime.sendMessage({ type: "STATUS" }));
  }

  async function configureHoldProvider(): Promise<void> {
    await apiPage().evaluate(async () => {
      await chrome.storage.session.set({ apiKey: "e2e-local-placeholder" });
      await chrome.storage.local.set({
        provider: "ollama",
        model: "e2e-hold-model",
        baseUrl: "http://localhost:11434/v1",
        provenance: "user",
        providerConfigs: {
          ollama: {
            model: "e2e-hold-model",
            baseUrl: "http://localhost:11434/v1",
            provenance: "user",
          },
        },
        maxSteps: 2,
        visionMode: "disabled",
        enableScreenshots: false,
      });
    });
  }

  async function startAuthoritativeHoldRun(
    agentPage: import("puppeteer-core").Page,
    task: string,
    mode: "standard" | "full_agentic",
  ): Promise<{ runId: string; dispatchRevision: number }> {
    await configureHoldProvider();
    await agentPage.bringToFront();
    const started = await apiPage().evaluate(async ({ runTask, runMode }) =>
      chrome.runtime.sendMessage({ type: "RUN", task: runTask, maxSteps: 2, mode: runMode }),
    { runTask: task, runMode: mode }) as { ok?: boolean; error?: string };
    expect(started).toMatchObject({ ok: true });
    try {
      return await apiPage().evaluate(async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const response = await chrome.runtime.sendMessage({ type: "STATUS" }) as {
            snapshot?: { status?: string; runId?: string; dispatchRevision?: number };
          };
          if (response.snapshot?.status === "running" &&
              typeof response.snapshot.runId === "string" &&
              typeof response.snapshot.dispatchRevision === "number") {
            return {
              runId: response.snapshot.runId,
              dispatchRevision: response.snapshot.dispatchRevision,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("timed out waiting for authoritative RUN token");
      });
    } catch (error) {
      throw new Error(`RUN did not reach running: ${JSON.stringify(await status())}`, { cause: error });
    }
  }

  async function startObservedDelayedBatch(
    page: import("puppeteer-core").Page,
    tabId: number,
    token: { runId: string; dispatchRevision: number },
    key: "__ocCancelE2E" | "__ocRestartBatch",
    mode: "standard" | "full_agentic",
  ): Promise<void> {
    await apiPage().evaluate(async ({ id, runToken, promiseKey, agentMode }) => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      scope[`${promiseKey}Settled`] = false;
      const batch = chrome.tabs.sendMessage(id, {
        type: "EXECUTE_ACTIONS",
        token: runToken,
        domainConfig: { allowedDomains: ["127.0.0.1"] },
        agentMode,
        actions: [
          { type: "click", index: 1 },
          { type: "wait", seconds: 10 },
          { type: "click", index: 2 },
        ],
      });
      scope[promiseKey] = batch.finally(() => {
        scope[`${promiseKey}Settled`] = true;
      });
    }, { id: tabId, runToken: token, promiseKey: key, agentMode: mode });

    // The entry click schedules this marker well after click settlement. When
    // it appears while the batch is still pending, the next (and only) queued
    // operation in flight is the ten-second wait.
    await page.waitForFunction(
      () => document.getElementById("wait-entered")?.textContent === "1",
      { polling: 25, timeout: 5_000 },
    );
    const settled = await apiPage().evaluate((promiseKey) => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;
      return scope[`${promiseKey}Settled`];
    }, key);
    expect(settled).toBe(false);
  }

  async function terminateServiceWorker(target: import("puppeteer-core").Target): Promise<void> {
    if (!browser) throw new Error("browser not launched");
    const session = await browser.target().createCDPSession();
    try {
      const targets = await session.send("Target.getTargets") as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      };
      const info = targets.targetInfos.find((candidate) =>
        candidate.type === "service_worker" && candidate.url === target.url(),
      );
      if (!info) throw new Error("extension service worker target was not found");
      await session.send("Target.closeTarget", { targetId: info.targetId });
      const restarted = browser.waitForTarget(
        (candidate) => candidate !== target && candidate.type() === "service_worker" &&
          candidate.url().startsWith("chrome-extension://"),
        { timeout: 20_000 },
      );
      // A terminated MV3 worker remains dormant until an extension event wakes
      // it. STATUS is both the wake event and the public recovery boundary.
      const wake = apiPage().evaluate(async () => chrome.runtime.sendMessage({ type: "STATUS" }));
      await Promise.all([restarted, wake]);
    } finally {
      await session.detach();
    }
  }


  /**
   * The id of the agent tab for `page` (a tab whose URL matches baseUrl).
   *
   * Earlier versions resolved the FIRST matching tab, which silently resolved
   * to a stale leaked tab after any prior test failed without cleaning up its
   * page — later EXTRACT_STATE / EXECUTE_ACTIONS batches then went to a dead
   * document (the "element never appears" / "navigation never commits" suite
   * failures). Tab ids are assigned monotonically and every test now closes
   * its pages even on failure, so the NEWEST matching tab is always the
   * current test's page; a leftover match is surfaced loudly as a leak hint.
   */
  async function agentTabId(page?: import("puppeteer-core").Page): Promise<number> {
    const tabIds = (await apiPage().evaluate(async (urlPrefix) => {
      const tabs = await chrome.tabs.query({ url: `${urlPrefix}*` });
      return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number");
    }, baseUrl)) as number[];
    if (tabIds.length === 0) throw new Error("no agent tab id");
    if (page && !page.url().startsWith(baseUrl)) {
      throw new Error(`agentTabId(page): page is at ${page.url()}, expected ${baseUrl}*`);
    }
    if (tabIds.length > 1) {
      // Best-effort leak diagnostic: the caller's page is the newest tab, but
      // a prior test left a tab open — surface it instead of guessing silently.
      console.warn(
        `[e2e] ${tabIds.length} agent tabs matched (${tabIds.join(", ")}) — ` +
          "a prior test may have leaked a tab; resolving to the newest",
      );
    }
    return Math.max(...tabIds);
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
        { getShadowRoot?: unknown; stats?: unknown }
      >)[Symbol.for(key)];
      return {
        hasGetShadowRoot: typeof bd?.getShadowRoot === "function",
        hasStats: typeof bd?.stats === "function",
      };
    }, PIERCER_BACKDOOR_KEY);
    expect(shape.hasGetShadowRoot).toBe(true);
    expect(shape.hasStats).toBe(true);
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
        { getShadowRoot?: (host: Element) => ShadowRoot | null }
      >)[Symbol.for(key)];
      return {
        // The production backdoor intentionally exposes only the minimal root
        // lookup consumed by the isolated-world extractor.
        pierced: bd?.getShadowRoot?.(host)?.querySelector("#inner")?.id === "inner",
        pageAlive:
          document.body !== null &&
          document.getElementById("normal-button")?.textContent === "click me",
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
    const tabId = await agentTabId(page);

    const injected = await apiPage().evaluate(async (id) => {
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
    const pong = (await apiPage().evaluate(async (id) => {
      try {
        return await chrome.tabs.sendMessage(id, { type: "PING" });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }, tabId)) as { ok?: boolean };
    expect(pong?.ok).toBe(true);
    await page.close();
  });

  test("a packaged isolated content world cannot read the session API key", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const tabId = await agentTabId(page);
    const fakeSessionKey = "phase3-fake-session-key";
    await apiPage().evaluate(async (key) => chrome.storage.session.set({ apiKey: key }), fakeSessionKey);

    // `executeScript` defaults to the same isolated world used by content.js.
    // This asks Chrome itself rather than relying on a unit-test rejection
    // double, so a future `setAccessLevel` privilege widening is visible in
    // the exact unpacked package.
    const result = await apiPage().evaluate(async (id) => {
      const [{ result: contentResult }] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: async () => {
          try {
            const value = await chrome.storage.session.get("apiKey");
            return { readable: true, value: value.apiKey };
          } catch (error) {
            return { readable: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      return contentResult as { readable: boolean; value?: unknown; error?: string };
    }, tabId);

    expect(result.readable).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(/storage|access|context/i);
    await page.close();
  });

  test("remembered local API key is migrated before an isolated content world can observe it", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const tabId = await agentTabId(page);
    const fakeRememberedKey = "phase3-fake-remembered-key";
    await apiPage().evaluate(async (key) => chrome.storage.local.set({
      apiKey: key,
      rememberApiKey: true,
    }), fakeRememberedKey);

    await expect.poll(async () => apiPage().evaluate(async () => {
      const value = await chrome.storage.local.get([
        "apiKey",
        "open_cowork_credential_manifest_v1",
        "open_cowork_credential_migration_v1",
      ]);
      const manifest = value.open_cowork_credential_manifest_v1 as { version?: unknown } | undefined;
      return {
        plaintextRemoved: value.apiKey === undefined,
        manifestReady: manifest?.version === 1,
        journalRemoved: value.open_cowork_credential_migration_v1 === undefined,
      };
    }), { timeout: 10_000 }).toEqual({
      plaintextRemoved: true,
      manifestReady: true,
      journalRemoved: true,
    });

    const result = await apiPage().evaluate(async (id) => {
      const [{ result: contentResult }] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: async () => {
          try {
            const value = await chrome.storage.local.get("apiKey");
            return { readable: true, value: value.apiKey };
          } catch (error) {
            return { readable: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      return contentResult as { readable: boolean; value?: unknown; error?: string };
    }, tabId);

    // storage.local remains available to the content script for non-secret
    // extension data, but credential bytes have moved to extension-origin IDB.
    expect(result.readable).toBe(true);
    expect(result.value).toBeUndefined();
    await page.close();
  });

  test("the packaged Options model picker stays usable from the bundled catalog when live catalog traffic is unavailable", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    const blockModelsDev = (request: import("puppeteer-core").HTTPRequest) => {
      if (new URL(request.url()).hostname === "models.dev") void request.abort();
      else void request.continue();
    };
    await page.setRequestInterception(true);
    page.on("request", blockModelsDev);
    try {
      await page.goto(`chrome-extension://${await extensionId()}/options.html`, { waitUntil: "load" });
      await page.waitForFunction(
        () => Boolean(document.querySelector("#provider option[value='openai']")),
        { timeout: 10_000 },
      );
      await page.evaluate(() => {
        const provider = document.getElementById("provider") as HTMLSelectElement;
        provider.value = "openai";
        provider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(
        () => document.querySelectorAll("#model-suggestions option").length > 0,
        { timeout: 10_000 },
      );
      const suggestionCount = await page.evaluate(
        () => document.querySelectorAll("#model-suggestions option").length,
      );
      expect(suggestionCount).toBeGreaterThan(0);
    } finally {
      page.off("request", blockModelsDev);
      await page.setRequestInterception(false);
      await page.close();
    }
  });

  test("packaged Options loads without an invalid CSP source diagnostic", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    const diagnostics: string[] = [];
    const recordDiagnostic = (text: string): void => {
      if (/content security policy/i.test(text) && /http:\/\/\[::1\]:\*/i.test(text)) {
        diagnostics.push(text);
      }
    };
    page.on("console", (message) => recordDiagnostic(message.text()));
    cdp.on("Log.entryAdded", ({ entry }) => recordDiagnostic(entry.text));

    try {
      // Enable the browser log before navigation so the meta-CSP parser's
      // diagnostic cannot race the test listener. Loading the exact packaged
      // Options document is sufficient to exercise CSP admission; no request
      // to models.dev or any external service is made by this fixture.
      await cdp.send("Log.enable");
      await page.goto(`chrome-extension://${await extensionId()}/options.html`, { waitUntil: "load" });
      await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 });

      // The Phase 4 package must admit the Options CSP without silently
      // discarding an invalid IPv6 wildcard source.
      expect(diagnostics).toEqual([]);
    } finally {
      await cdp.detach();
      await page.close();
    }
  });

  test("evaluate sandbox fails closed under the MV3 extension CSP", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "load" });
      const tabId = await agentTabId(page);
      await apiPage().evaluate(async (id) => {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
      }, tabId);
      // Same isolated-world liveness check as the injection test: the content
      // script must be listening before EXECUTE_ACTIONS can round-trip.
      const pong = (await apiPage().evaluate(async (id) => {
        try {
          return await chrome.tabs.sendMessage(id, { type: "PING" });
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }, tabId)) as { ok?: boolean };
      expect(pong?.ok).toBe(true);

      // Exercise the production authorization handshake: content obtains an
      // opaque action capability from the live background controller before the
      // evaluate handler reaches its CSP-governed effect boundary.
      await apiPage().evaluate(async () => {
        await chrome.storage.session.set({ apiKey: "e2e-local-placeholder" });
        await chrome.storage.local.set({
          provider: "ollama",
          model: "e2e-hold-model",
          baseUrl: "http://localhost:11434/v1",
          provenance: "user",
          providerConfigs: {
            ollama: {
              model: "e2e-hold-model",
              baseUrl: "http://localhost:11434/v1",
              provenance: "user",
            },
          },
          maxSteps: 2,
          visionMode: "disabled",
          enableScreenshots: false,
        });
      });
      await page.bringToFront();
      const started = await apiPage().evaluate(async () =>
        chrome.runtime.sendMessage({
          type: "RUN",
          task: "Hold the provider while testing the evaluate sandbox.",
          maxSteps: 2,
          mode: "full_agentic",
        }),
      ) as { ok?: boolean };
      expect(started.ok).toBe(true);
      // Poll STATUS and record the observed timeline. The RUN MUST reach an
      // admitted "starting"/"running" snapshot within the window — a terminal
      // or absent snapshot before that point is a genuine admission failure.
      // The dispatch token is minted from the admitted snapshot (the exact
      // authority the background controller issued), keeping the handshake
      // honest while making the wait robust to a fast-failing first poll.
      const observedStatuses: string[] = [];
      const admissionDeadline = Date.now() + 20_000;
      let active: { snapshot: { runId: string; dispatchRevision: number } } | null = null;
      while (Date.now() < admissionDeadline) {
        const poll = await apiPage().evaluate(async () => {
          const r = await chrome.runtime.sendMessage({ type: "STATUS" }) as {
            snapshot?: { status?: string; runId?: string; dispatchRevision?: number };
          };
          const persisted = (await chrome.storage.session.get("open_cowork_run_snapshot_v1"))
            .open_cowork_run_snapshot_v1 as { status?: string } | undefined;
          return {
            status: r.snapshot?.status ?? null,
            runId: r.snapshot?.runId,
            dispatchRevision: r.snapshot?.dispatchRevision,
            persistedStatus: persisted?.status ?? null,
          };
        });
        if (poll.status) {
          const suffix = poll.persistedStatus && poll.persistedStatus !== poll.status
            ? `(persisted:${poll.persistedStatus})`
            : "";
          observedStatuses.push(`${poll.status}${suffix}`);
        }
        if (poll.status === "starting" || poll.status === "running" || poll.status === "cancelling") {
          if (typeof poll.runId === "string" && typeof poll.dispatchRevision === "number") {
            active = { snapshot: { runId: poll.runId, dispatchRevision: poll.dispatchRevision } };
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        active,
        `RUN must reach an admitted starting/running snapshot within 20s; ` +
          `observed statuses: ${observedStatuses.join(" → ") || "(none — STATUS returned no snapshot)"}`,
      ).not.toBeNull();
      if (!active) throw new Error("RUN admission produced no dispatch token");

      // evaluate is fail-closed without a domain allowlist; grant one for the
      // local origin so the sandbox itself is what runs.
      const res = (await apiPage().evaluate(async ({ id, token }) => {
        return chrome.tabs.sendMessage(id, {
          type: "EXECUTE_ACTIONS",
          token,
          domainConfig: { allowedDomains: ["127.0.0.1"] },
          agentMode: "full_agentic",
          actions: [{ type: "evaluate", code: "1 + 1" }],
        });
      }, { id: tabId, token: active.snapshot })) as { ok?: boolean; results?: Array<{ success?: boolean; extractedContent?: string; message?: string }> };

      expect(res?.ok).toBe(true);
      expect(res?.results?.[0]?.success).toBe(false);
      expect(res?.results?.[0]?.message).toMatch(/Content Security Policy|unsafe-eval/i);
      await apiPage().evaluate(async () => chrome.runtime.sendMessage({ type: "STOP" }));
      await apiPage().waitForFunction(async () => {
        const response = await chrome.runtime.sendMessage({ type: "STATUS" }) as {
          snapshot?: { status?: string };
        };
        const persisted = (await chrome.storage.session.get("open_cowork_run_snapshot_v1"))
          .open_cowork_run_snapshot_v1 as { status?: string } | undefined;
        return response.snapshot?.status === "cancelled" && persisted?.status === "cancelled";
      }, { timeout: 20_000 });
      // A completed controller intentionally remains in memory so repeated
      // STATUS calls are idempotent. Restart the test worker to prevent that
      // valid in-memory terminal projection from shadowing the next test's
      // directly seeded persisted-snapshot fixture.
      await terminateServiceWorker(await serviceWorkerTarget());
    } finally {
      // The RUN handshake may fail mid-test (e.g. a racing worker restart);
      // the page and worker MUST still be cleaned up so later tests never
      // resolve agentTabId() to a stale leaked tab.
      await apiPage().evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: "STOP" }); } catch { /* worker may be stopping */ }
      });
      try { await terminateServiceWorker(await serviceWorkerTarget()); } catch { /* cleanup is best-effort */ }
      await page.close();
    }
  });

  test("CANCEL_RUN aborts an active batch within one second and blocks every later action", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const tabId = await agentTabId(page);
    await apiPage().evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    }, tabId);
    try {
      const token = await startAuthoritativeHoldRun(
        page,
        "Hold the provider while the direct cancellation batch waits.",
        "full_agentic",
      );
      await startObservedDelayedBatch(page, tabId, token, "__ocCancelE2E", "full_agentic");

      const startedAt = Date.now();
      const cancelled = await apiPage().evaluate(async () =>
        chrome.runtime.sendMessage({ type: "STOP" })) as { ok?: boolean };
      expect(cancelled.ok).toBe(true);
      const response = (await apiPage().evaluate(async () => {
        const scope = globalThis as typeof globalThis & { __ocCancelE2E?: Promise<unknown> };
        return scope.__ocCancelE2E;
      })) as { ok?: boolean; results?: Array<{ success?: boolean; message?: string }> };
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(response.ok).toBe(true);
      expect(response.results).toHaveLength(3);
      expect(response.results?.[0]?.success).toBe(true);
      expect(response.results?.slice(1).every((result) => result.success === false)).toBe(true);
      expect(await page.$eval("#click-count", (element) => element.textContent)).toBe("0");

      const stale = (await apiPage().evaluate(async ({ id, runToken }) => chrome.tabs.sendMessage(id, {
        type: "EXECUTE_ACTIONS",
        token: runToken,
        agentMode: "full_agentic",
        actions: [{ type: "click", index: 2 }],
      }), { id: tabId, runToken: token })) as { ok?: boolean; error?: string };
      expect(stale.ok).toBe(false);
      expect(stale.error).toMatch(/cancelled|stale/i);
      expect(await page.$eval("#click-count", (element) => element.textContent)).toBe("0");
    } finally {
      await apiPage().evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: "STOP" }); } catch { /* worker may be stopping */ }
      });
      try { await terminateServiceWorker(await serviceWorkerTarget()); } catch { /* cleanup is best-effort */ }
      await page.close();
    }
  }, 60_000);

  test("two open panels converge on a successor run and panel B performs the real STOP", async () => {
    if (!browser) throw new Error("browser not launched");
    const oldTerminal = {
      version: 1,
      runId: "panel-run-a",
      revision: 20,
      dispatchRevision: 4,
      task: "Completed predecessor",
      maxSteps: 2,
      mode: "standard",
      status: "succeeded",
      phase: "terminal",
      step: 1,
      startedAt: Date.now() - 2_000,
      updatedAt: Date.now() - 1_000,
      endedAt: Date.now() - 1_000,
      terminalReason: "succeeded",
      terminalMessage: "Predecessor completed.",
      resultText: "Run A result.",
    };
    await apiPage().evaluate(async (snapshot) => {
      await chrome.storage.session.clear();
      await chrome.storage.session.set({
        open_cowork_run_snapshot_v1: snapshot,
        apiKey: "e2e-local-placeholder",
      });
      await chrome.storage.local.set({
        provider: "ollama",
        model: "e2e-hold-model",
        baseUrl: "http://localhost:11434/v1",
        provenance: "user",
        providerConfigs: {
          ollama: {
            model: "e2e-hold-model",
            baseUrl: "http://localhost:11434/v1",
            provenance: "user",
          },
        },
        maxSteps: 2,
        visionMode: "disabled",
        enableScreenshots: false,
      });
    }, oldTerminal);

    const agentPage = await browser.newPage();
    await agentPage.goto(baseUrl, { waitUntil: "load" });
    const panelA = await openPanel(1100);
    const panelB = await openPanel(360);
    try {      await Promise.all([panelA, panelB].map((panel) => panel.waitForFunction(
        () => document.querySelector("#statusLabel")?.textContent === "Done ✓",
        { polling: 50, timeout: 10_000 },
      )));

      await sendTaskWithoutActivatingPanel(panelA, agentPage, "Wait for Stop in the packaged cancellation test.");
      await panelA.waitForFunction(
        () => document.querySelector("#statusLabel")?.textContent !== "Done ✓",
        { polling: 50, timeout: 10_000 },
      );
      await apiPage().waitForFunction(async () => {
        const response = await chrome.runtime.sendMessage({ type: "STATUS" }) as { snapshot?: { status?: string } };
        return Boolean(response.snapshot && ["starting", "running", "cancelling"].includes(response.snapshot.status ?? ""));
      }, { timeout: 10_000 });
      const active = await status() as {
        snapshot: { runId: string; revision: number };
      };

      // Panel B is intentionally still attached to terminal run A. A legitimate
      // versioned event for B's unknown run ID must trigger STATUS reconciliation
      // even when transcript admission rejects the event itself.
      await apiPage().evaluate(async (snapshot) => {
        await chrome.runtime.sendMessage({
          type: "AGENT_EVENT",
          event: { type: "info", message: "Run B is active." },
          runId: snapshot.runId,
          revision: snapshot.revision,
          time: "00:00:00",
        });
      }, active.snapshot);
      await panelB.waitForFunction(
        () => {
          const label = document.querySelector("#statusLabel")?.textContent;
          return ["Starting…", "Thinking…", "Acting…"].includes(label ?? "") &&
            !(document.querySelector("#stopBtn") as HTMLButtonElement).disabled;
        },
        { polling: 50, timeout: 10_000 },
      );

      const stopAt = Date.now();
      await panelB.evaluate(() => (document.querySelector("#stopBtn") as HTMLButtonElement).click());
      await Promise.all([panelA, panelB].map((panel) => panel.waitForFunction(
        () => document.querySelector("#statusLabel")?.textContent === "Cancelled",
        { polling: 50, timeout: 10_000 },
      )));
      expect(Date.now() - stopAt).toBeLessThan(1_000);
      const terminal = await status();
      expect(terminal.snapshot).toMatchObject({
        runId: active.snapshot.runId,
        status: "cancelled",
        terminalReason: "cancelled",
      });
      // cleanupRun persists the history record AFTER the terminal snapshot is
      // broadcast to the panels, so "Cancelled" on both panels is not a barrier
      // for the record itself — wait for it (condition-based, same assertion).
      await apiPage().waitForFunction(async (runId) => {
        const history = (await chrome.storage.local.get("open_cowork_run_history"))
          .open_cowork_run_history as Array<{ id?: string }> | undefined;
        return Boolean(history?.some((record) => record.id === runId));
      }, { polling: 50, timeout: 10_000 }, active.snapshot.runId);
      const history = await apiPage().evaluate(async () =>
        (await chrome.storage.local.get("open_cowork_run_history")).open_cowork_run_history as Array<{
          id?: string; terminalReason?: string; result?: { success?: boolean };
        }> | undefined,
      );
      expect(history?.find((record) => record.id === active.snapshot.runId)).toMatchObject({
        terminalReason: "cancelled",
        result: { success: false },
      });

      // Start a second run from the same loaded panel and prove the input/run
      // controls are reusable without a reload, then stop it deterministically.
      await sendTaskWithoutActivatingPanel(panelA, agentPage, "Start the reusable second run.");
      await apiPage().waitForFunction(async (previousRunId) => {
        const response = await chrome.runtime.sendMessage({ type: "STATUS" }) as { snapshot?: { runId?: string; status?: string } };
        return response.snapshot?.runId !== previousRunId &&
          ["starting", "running"].includes(response.snapshot?.status ?? "");
      }, { timeout: 10_000 }, active.snapshot.runId);
      await panelA.waitForFunction(
        () => {
          const label = document.querySelector("#statusLabel")?.textContent;
          return ["Starting…", "Thinking…", "Acting…"].includes(label ?? "") &&
            !(document.querySelector("#stopBtn") as HTMLButtonElement).disabled;
        },
        { polling: 50, timeout: 10_000 },
      );
      await panelA.evaluate(() => (document.querySelector("#stopBtn") as HTMLButtonElement).click());
      await panelA.waitForFunction(
        () => document.querySelector("#statusLabel")?.textContent === "Cancelled",
        { polling: 50, timeout: 10_000 },
      );
      expect(await panelA.$eval("#messageInput", (element) => (element as HTMLTextAreaElement).disabled)).toBe(false);

    } finally {
      // On ANY failure the panels and agent page must still be closed: a
      // leaked baseUrl tab would poison agentTabId() for every later test.
      await panelA.close().catch(() => {});
      await panelB.close().catch(() => {});
      await agentPage.close().catch(() => {});
    }
  }, 60_000);

  test("worker restart revokes a surviving delayed batch before its click", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    const tabId = await agentTabId(page);
    await apiPage().evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    }, tabId);
    try {
      // The preceding panel journey intentionally leaves a terminal controller
      // resident for idempotent STATUS reads. Cross a real worker boundary so
      // this restart test first recovers that terminal projection, then starts
      // its own authority through RUN.
      await terminateServiceWorker(await serviceWorkerTarget());
      await apiPage().waitForFunction(async () => {
        const state = (await chrome.storage.session.get("open_cowork_run_state"))
          .open_cowork_run_state as { active?: boolean } | undefined;
        return !state?.active;
      }, { polling: 50, timeout: 10_000 });
      const token = await startAuthoritativeHoldRun(
        page,
        "Hold the provider while the worker restart batch waits.",
        "standard",
      );
      await startObservedDelayedBatch(page, tabId, token, "__ocRestartBatch", "standard");

      const oldTarget = await serviceWorkerTarget();
      await terminateServiceWorker(oldTarget);
      await apiPage().waitForFunction(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: "STATUS" }) as { snapshot?: { status?: string } };
          return response.snapshot?.status === "interrupted";
        } catch {
          return false;
        }
      }, { timeout: 20_000 });
      const recovered = await status() as {
        snapshot: { runId: string; dispatchRevision: number; terminalReason: string };
      };
      expect(recovered.snapshot).toMatchObject({
        runId: token.runId,
        dispatchRevision: token.dispatchRevision + 1,
        terminalReason: "interrupted",
      });
      const batch = await apiPage().evaluate(async () => {
        const scope = globalThis as typeof globalThis & { __ocRestartBatch?: Promise<unknown> };
        return scope.__ocRestartBatch;
      }) as { results?: Array<{ success?: boolean }> };
      expect(batch.results?.[0]?.success).toBe(true);
      expect(batch.results?.slice(1).every((result) => result.success === false)).toBe(true);
      expect(await page.$eval("#click-count", (element) => element.textContent)).toBe("0");
    } finally {
      await apiPage().evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: "STOP" }); } catch { /* worker may be restarting */ }
      });
      try { await terminateServiceWorker(await serviceWorkerTarget()); } catch { /* cleanup is best-effort */ }
      await page.close();
    }
  }, 60_000);

  test("narrow side panel hydrates authoritative progress and terminal state without overflow", async () => {
    if (!browser) throw new Error("browser not launched");
    const id = await extensionId();
    // Wake the worker and let restart recovery finish before injecting the
    // synthetic live projection. A snapshot present during startup is
    // correctly terminalized as interrupted by the recovery gate.
    await status();
    const running = {
      version: 1,
      runId: "visual-run",
      revision: 3,
      dispatchRevision: 1,
      task: "Summarize the current page and identify the next safe action",
      maxSteps: 30,
      mode: "restricted",
      status: "running",
      phase: "reasoning",
      step: 2,
      startedAt: Date.now() - 2_000,
      updatedAt: Date.now(),
      activeOperation: "Choosing the next action",
      usage: { tokensIn: 1200, tokensOut: 180, costUsd: 0.0042, model: "e2e-fixture-model" },
    };
    await apiPage().evaluate(async (snapshot) => {
      await chrome.storage.session.remove("open_cowork_interrupted_notice");
      await chrome.storage.session.set({ open_cowork_run_snapshot_v1: snapshot });
    }, running);
    expect(await status()).toMatchObject({ running: true, snapshot: running });

    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 720, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${id}/sidepanel.html`, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#statusLabel")?.textContent === "Thinking…",
      { timeout: 10_000 },
    );
    const runningView = await page.evaluate(() => ({
      task: document.querySelector("#runTaskLabel")?.textContent,
      phase: document.querySelector("#runPhaseLabel")?.textContent,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      stopDisabled: (document.querySelector("#stopBtn") as HTMLButtonElement | null)?.disabled,
    }));
    expect(runningView).toMatchObject({
      task: running.task,
      phase: "reasoning · step 2",
      overflow: false,
      stopDisabled: false,
    });
    if (E2E_ARTIFACT_DIR) {
      await page.screenshot({ path: path.join(E2E_ARTIFACT_DIR, "phase1-sidepanel-running-narrow-chrome.png") });
    }

    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#statusLabel")?.textContent === "Thinking…",
      { timeout: 10_000 },
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    if (E2E_ARTIFACT_DIR) {
      await page.screenshot({ path: path.join(E2E_ARTIFACT_DIR, "phase1-sidepanel-running-desktop-chrome.png") });
    }

    const terminal = {
      ...running,
      revision: 4,
      dispatchRevision: 2,
      status: "succeeded",
      phase: "terminal",
      updatedAt: Date.now(),
      endedAt: Date.now(),
      terminalReason: "succeeded",
      terminalMessage: "Summary completed.",
      resultText: "The page is ready for review.",
    };
    await apiPage().evaluate(async (snapshot) => {
      await chrome.storage.session.set({ open_cowork_run_snapshot_v1: snapshot });
    }, terminal);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#statusLabel")?.textContent === "Done ✓",
      { timeout: 10_000 },
    );
    const terminalView = await page.evaluate(() => ({
      transcript: document.querySelector("#chatMessages")?.textContent,
      inputDisabled: (document.querySelector("#messageInput") as HTMLTextAreaElement | null)?.disabled,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(terminalView.transcript).toContain("The page is ready for review.");
    expect(terminalView.inputDisabled).toBe(false);
    expect(terminalView.overflow).toBe(false);
    if (E2E_ARTIFACT_DIR) {
      await page.screenshot({ path: path.join(E2E_ARTIFACT_DIR, "phase1-sidepanel-terminal-chrome.png") });
    }
    await page.close();
  });

  // ─── Phase 10: browser-real action-family coverage ─────────────────────────
  // Runs ONLY when E2E_CHROME=1 (the whole describe is skipped otherwise).
  // Exercises the highest-risk content-script action families against a real
  // Chrome: click, input, evaluate, navigate, screenshot. Each batch goes
  // through the canonical EXECUTE_ACTIONS path (dispatch token + effect
  // authorization) so capability gating is exercised for real.

  /** Inject content.js into the agent tab and start an authoritative hold run. */
  async function prepareActionRun(
    page: import("puppeteer-core").Page,
  ): Promise<{ tabId: number; token: { runId: string; dispatchRevision: number } }> {
    const tabId = await agentTabId(page);
    await apiPage().evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    }, tabId);
    const token = await startAuthoritativeHoldRun(page, "Hold for browser-real action coverage.", "full_agentic");
    return { tabId, token };
  }

  async function stopActionRun(): Promise<void> {
    await apiPage().evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: "STOP" }); } catch { /* worker may be stopping */ }
    });
    try { await terminateServiceWorker(await serviceWorkerTarget()); } catch { /* best-effort */ }
  }

  /** Send an EXECUTE_ACTIONS batch and return the typed response. */
  async function runBatch(
    tabId: number,
    token: { runId: string; dispatchRevision: number },
    actions: unknown[],
  ): Promise<{ ok?: boolean; results?: Array<{ success?: boolean; message?: string; extractedContent?: string }>; error?: string }> {
    const res = await apiPage().evaluate(async ({ id, runToken, actions: batch }) => {
      try {
        return await chrome.tabs.sendMessage(id, {
          type: "EXECUTE_ACTIONS",
          token: runToken,
          domainConfig: { allowedDomains: ["127.0.0.1"] },
          agentMode: "full_agentic",
          actions: batch,
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, { id: tabId, runToken: token, actions });
    return res ?? {};
  }

  /** Extract page state and resolve the [index] of the element with `id`. */
  async function indexOfElement(tabId: number, id: string): Promise<number> {
    // The test may append the element and immediately extract; the content
    // script's snapshot is a fresh DOM walk, but the walk can race the very
    // last mutation in some schedulings. Poll briefly so a genuinely present
    // element is never missed by a one-shot snapshot.
    let lastElements: Array<{ index: number; attributes: Record<string, string>; text: string }> = [];
    let attempts = 0;
    for (; attempts < 10; attempts++) {
      const response = await apiPage().evaluate(async (id_) => {
        return await chrome.tabs.sendMessage(id_, { type: "EXTRACT_STATE", includeAxTree: false });
      }, tabId) as { ok?: boolean; state?: { elements?: Array<{ index: number; attributes: Record<string, string>; text: string }> } };
      expect(response?.ok).toBe(true);
      lastElements = response?.state?.elements ?? [];
      if (lastElements.some((el) => el.attributes.id === id)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const match = lastElements.find((el) => el.attributes.id === id);
    expect(match, `element #${id} must be present in the extracted snapshot (${attempts + 1} attempts)`).toBeDefined();
    return match!.index;
  }

  test("browser-real: click + input + evaluate families act on the live page through EXECUTE_ACTIONS", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    try {
      // Give the action pipeline a real text field to type into.
      await page.evaluate(() => {
        const input = document.createElement("input");
        input.id = "e2e-input";
        document.body.append(input);
      });
      const { tabId, token } = await prepareActionRun(page);

      const clickIndex = await indexOfElement(tabId, "normal-button");
      const inputIndex = await indexOfElement(tabId, "e2e-input");

      const res = await runBatch(tabId, token, [
        { type: "click", index: clickIndex },
        { type: "input", index: inputIndex, text: "e2e typed value", clear: true },
        { type: "evaluate", code: "document.title = 'e2e-evaluated'; return 7;" },
      ]);

      expect(res.ok).toBe(true);
      expect(res.results).toHaveLength(3);
      expect(res.results?.[0]?.success, `click [${clickIndex}] must succeed`).toBe(true);
      expect(res.results?.[1]?.success, `input [${inputIndex}] must succeed`).toBe(true);

      // The click and input DOM effects are real: the button handler fired and
      // the typed value landed in the shared document.
      await page.waitForFunction(() => document.getElementById("click-count")?.textContent === "1", { timeout: 10_000 });
      expect(await page.$eval("#e2e-input", (el) => (el as HTMLInputElement).value)).toBe("e2e typed value");

      // Evaluate is the RCE-class primitive. Its sandbox (`new Function`) is
      // governed by the effective CSP of the content-script isolated world,
      // which inherits the extension's `extension_pages` CSP
      // (`script-src 'self' 'wasm-unsafe-eval'` — no `unsafe-eval`). The domain
      // allowlist from the batch IS honored (the failure surfaces downstream of
      // the allowlist gate, at Function construction), so the truthful MV3
      // outcome is a typed ActionResult that FAILS CLOSED with the CSP
      // diagnostic — the exact fail-closed contract the "evaluate sandbox
      // fails closed under the MV3 extension CSP" test pins. A false success
      // must never be asserted here; if the CSP is ever deliberately loosened
      // (e.g. a sandboxed extension page), this assertion documents the change.
      const evaluateResult = res.results?.[2];
      expect(evaluateResult, "evaluate must return a typed ActionResult").toBeDefined();
      expect(typeof evaluateResult?.success).toBe("boolean");
      if (evaluateResult?.success) {
        // Success is only reachable when the evaluated page's world permits
        // `new Function` (not under the packaged MV3 CSP) — keep the DOM
        // effect assertion honest either way.
        expect(await page.title()).toBe("e2e-evaluated");
      } else {
        expect(evaluateResult?.message).toMatch(/Content Security Policy|unsafe-eval|JS evaluation failed/i);
      }
    } finally {
      await stopActionRun();
      await page.close();
    }
  }, 120_000);

  test("browser-real: navigate changes the live tab (same-origin, domain-gated)", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    try {
      const { tabId, token } = await prepareActionRun(page);
      const target = `${baseUrl}?nav=e2e`;
      // The response value is intentionally not asserted for a same-tab
      // navigation (the content-script port closes mid-request); the committed
      // URL below is the assertion.
      await runBatch(tabId, token, [{ type: "navigate", url: target, new_tab: false }]);
      // A same-tab navigation destroys the content-script execution context
      // mid-request, so the EXECUTE_ACTIONS response channel (a port into the
      // content script) can close before the reply is delivered — `res.ok` may
      // be undefined even when the navigation committed. The navigation itself
      // is the assertion; it is committed exactly when the live document lands
      // on the target URL. Under a cold worker the RUN admission + navigation
      // can take several seconds, so the condition wait is generous.
      await page.waitForFunction(
        (expected) => location.href === expected,
        { timeout: 25_000 },
        target,
      );
      expect(await page.url()).toBe(target);
      // The committed navigation is the pass condition for the same-tab case;
      // the response is best-effort. (The new_tab:true case below asserts the
      // live response, which survives because the content script stays alive.)
    } finally {
      await stopActionRun();
      await page.close();
    }
  }, 120_000);

  test("browser-real: navigate with new_tab keeps the content script alive and returns a live response", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    let target = "";
    await page.goto(baseUrl, { waitUntil: "load" });
    try {
      const { tabId, token } = await prepareActionRun(page);
      target = `${baseUrl}?nav=newtab-e2e`;
      const res = await runBatch(tabId, token, [{ type: "navigate", url: target, new_tab: true }]);
      // new_tab:true keeps the dispatching content script alive, so the
      // TAB_ACTION response round-trips like any other action.
      expect(res.ok, `navigate(new_tab:true) must return a live response: ${JSON.stringify(res)}`).toBe(true);
      expect(res.results?.[0]?.success).toBe(true);
      // The navigation must have committed in a NEW tab (the origin matches).
      await browser!.waitForTarget(
        (t) => t.type() === "page" && t.url().startsWith(new URL(target).origin) && t.url().includes("nav=newtab-e2e"),
        { timeout: 15_000 },
      );
    } finally {
      await stopActionRun();
      // The navigate(new_tab:true) action opened a SECOND tab at `target`
      // (it outlives this test's `page`). Close it so agentTabId() never
      // resolves later tests to a leaked baseUrl tab.
      await apiPage().evaluate(async ({ urlPrefix, targetUrl }) => {
        const tabs = await chrome.tabs.query({ url: `${urlPrefix}*` });
        const leaked = tabs.filter((tab) => tab.url === targetUrl && typeof tab.id === "number");
        await Promise.all(leaked.map((tab) => chrome.tabs.remove(tab.id!)));
      }, { urlPrefix: baseUrl, targetUrl: target }).catch(() => { /* best-effort cleanup */ });
      await page.close();
    }
  }, 120_000);

  test("browser-real: screenshot action captures and reports truthfully", async () => {
    if (!browser) throw new Error("browser not launched");
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    try {
      const { tabId, token } = await prepareActionRun(page);
      const res = await runBatch(tabId, token, [{ type: "screenshot", file_name: "e2e-proof" }]);
      const result = res.results?.[0];
      expect(result, "screenshot must return a typed ActionResult").toBeDefined();
      expect(typeof result?.success).toBe("boolean");
      if (result?.success) {
        expect(result.message).toMatch(/Screenshot saved/);
      } else {
        // A graceful, honest failure is acceptable in constrained headless
        // environments (downloads disabled) — a false success is not.
        expect(result?.message).toMatch(/screenshot failed/i);
      }
      if (E2E_ARTIFACT_DIR && result?.success) {
        await page.screenshot({ path: path.join(E2E_ARTIFACT_DIR, "phase10-e2e-screenshot-action.png") });
      }
    } finally {
      await stopActionRun();
      await page.close();
    }
  }, 120_000);
});
