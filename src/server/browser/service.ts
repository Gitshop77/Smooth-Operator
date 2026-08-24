import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { platform } from "node:process";

import type { Browser, CDPSession, ConsoleMessage, Dialog, ElementHandle, Frame, HTTPRequest, HTTPResponse, KeyInput, Page, Target } from "puppeteer-core";

type PuppeteerModule = typeof import("puppeteer-core").default;
type PuppeteerLaunchOptions = Parameters<PuppeteerModule["launch"]>[0];
type PuppeteerConnectOptions = Parameters<PuppeteerModule["connect"]>[0];
let puppeteerModulePromise: Promise<PuppeteerModule> | undefined;

function loadPuppeteer(): Promise<PuppeteerModule> {
  puppeteerModulePromise ??= import("puppeteer-core").then((module) => module.default);
  return puppeteerModulePromise;
}

import type { ServerConfig } from "../config";
import { AppError, asAppError, requireField } from "../errors";
import { BrowserActionPlanSchema, isDestructiveBatchAction, type BrowserAction } from "../contracts";
import { Logger, redactValue } from "../logger";
import { SecurityPolicy } from "../policy";
import { redactSecretPlaceholders, wrapUntrustedText } from "../security";
import { classifyChallenge } from "./challenges";
import { nativeBrowserLaunchArgs } from "./compatibility";
import { chromeExecutableSearchPaths, findChromeExecutable } from "./discovery";
import { globMatches, sanitizeUrl as safeUrl } from "./utils";

interface BrowserTab {
  id: string;
  tab_id: string;
  index: number;
  url: string;
  title: string;
  active: boolean;
}

interface InteractiveElement {
  ref: string;
  index: number;
  selector: string;
  tag: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  type?: string;
  valuePresent?: boolean;
  disabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

interface SnapshotInteractiveElement extends InteractiveElement {
  signature: string;
}

interface SnapshotEvaluation {
  text: string;
  textTruncated: boolean;
  headings: string[];
  interactive: SnapshotInteractiveElement[];
  interactiveTruncated: boolean;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  readyState: string;
  scroll: { x: number; y: number; maxX: number; maxY: number };
}

interface RefTarget {
  selector: string;
  signature: string;
  snapshotId: string;
  frameId: string;
  index: number;
}

interface FrameSummary {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  origin: string | null;
  sameOrigin: boolean;
  title: string;
}

interface ScreenshotMetadata {
  width: number;
  height: number;
  bytes: number;
  format: "png" | "jpeg";
  fullPage: boolean;
  scale: number;
  quality?: number;
}

interface ScreenshotCapture {
  screenshotBase64: string;
  metadata: ScreenshotMetadata;
}

interface ClickDescriptor {
  tag: string;
  type: string;
  role: string;
  label: string;
}

interface ClickMonitorResult {
  navigated: boolean;
  urlChanged: boolean;
  url?: string;
}

export interface PageSnapshot {
  pageId: string;
  frameId: string;
  snapshotId: string;
  domRevision: number;
  url: string;
  title: string;
  text: string;
  textTruncated: boolean;
  headings: string[];
  interactive: InteractiveElement[];
  interactiveTruncated: boolean;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  readyState: string;
  scroll: { x: number; y: number; maxX: number; maxY: number };
  frames?: unknown[];
  screenshotBase64?: string;
  screenshot?: ScreenshotMetadata;
}

interface LogEntry {
  timestamp: string;
  type: string;
  url?: string;
  untrustedUrl?: string;
  method?: string;
  status?: number;
  text?: string;
  level?: string;
}

interface PendingDialog {
  dialog: Dialog;
  type: string;
  text: string;
}

interface PageState {
  id: string;
  page: Page;
  lifecycleGeneration: number;
  disposed: boolean;
  refs: Map<string, RefTarget>;
  snapshotId?: string;
  snapshotInteractive?: InteractiveElement[];
  domRevision: number;
  networkEnabled: boolean;
  consoleEnabled: boolean;
  network: LogEntry[];
  console: LogEntry[];
  dialogs: PendingDialog[];
  listenersInstalled: boolean;
  timeoutsConfigured: boolean;
  downloadConfigured: boolean;
  navigationGuardInstalled: boolean;
  networkRequestListener?: (request: HTTPRequest) => void;
  networkResponseListener?: (response: HTTPResponse) => void;
  consoleListener?: (message: ConsoleMessage) => void;
  dialogListener?: (dialog: Dialog) => void;
  frameNavigatedListener?: (frame: Frame) => void;
  frameAttachedListener?: (frame: Frame) => void;
  frameDetachedListener?: (frame: Frame) => void;
  pageCloseListener?: () => void;
  navigationRequestListener?: (request: HTTPRequest) => void;
  configurationPromise?: Promise<void>;
  navigationError?: { generation: number; error: AppError };
  navigationGeneration: number;
  activeNavigationGeneration?: number;
  mainFrameStatus?: number;
  challengeActive: boolean;
  dialogResolutionPromise?: Promise<void>;
}

interface TargetGuardSession {
  session: CDPSession;
  targetId: string;
  targetType: string;
  requestPausedListener: (event: unknown) => void;
  disconnectedListener: (event: unknown) => void;
  enabled: boolean;
  released: boolean;
  requestIds: Set<string>;
  pendingRequests: Set<Promise<void>>;
  originalSend?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  wrappedSend?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

interface TargetGuardConnection {
  on(event: string, listener: (value: unknown) => void): void;
  off?(event: string, listener: (value: unknown) => void): void;
  emit?(event: string, value: unknown): boolean;
  session?(sessionId: string): unknown;
  _session?(sessionId: string): unknown;
  _sessions?: Map<string, unknown>;
  isAutoAttached?(targetId: string): boolean;
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface TargetAttachedEvent {
  sessionId: string;
  targetInfo: {
    targetId: string;
    type?: string;
    url?: string;
  };
}

interface PopupObservation {
  popup?: Page;
  createdPages: Set<Page>;
  pendingPagePromises: Set<Promise<void>>;
}

interface DevToolsVersion {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
}

interface BenchmarkCounters {
  browserOperations: number;
  pageLookups: number;
  pageEnumerations: number;
  pageEvaluations: number;
  cdpCommands: number;
}

export interface BrowserServiceDependencies {
  launch?: (options: PuppeteerLaunchOptions) => Promise<Browser>;
  connect?: (options: PuppeteerConnectOptions) => Promise<Browser>;
  probeEndpoint?: (browserURL: string, timeoutMs: number) => Promise<DevToolsVersion>;
}

interface ManagedEndpointProbe {
  state: "no-file" | "stale-probe-failed" | "live";
  browserURL?: string;
  version?: DevToolsVersion;
}

export interface BrowserShutdownOutcome {
  closed: boolean;
  owned: boolean;
  succeeded: boolean;
}

const MAX_LOG_ENTRIES = 500;
const MAX_ACTION_PLAN_STEPS = 100;
const MAX_QUEUED_OPERATIONS = 64;
const NEW_TAB_DETECTION_TIMEOUT_MS = 1_000;
const TARGET_GUARD_MAX_REQUEST_IDS = 128;
const SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS = 1_000;
const COMMON_KEY_ALIASES: Readonly<Record<string, KeyInput>> = {
  ALT: "Alt",
  ARROWDOWN: "ArrowDown",
  ARROWLEFT: "ArrowLeft",
  ARROWRIGHT: "ArrowRight",
  ARROWUP: "ArrowUp",
  BACKSPACE: "Backspace",
  CMD: "Meta",
  COMMAND: "Meta",
  CONTROL: "Control",
  CTRL: "Control",
  DELETE: "Delete",
  DEL: "Delete",
  DOWN: "ArrowDown",
  END: "End",
  ENTER: "Enter",
  ESC: "Escape",
  ESCAPE: "Escape",
  HOME: "Home",
  INSERT: "Insert",
  INS: "Insert",
  LEFT: "ArrowLeft",
  META: "Meta",
  OPTION: "Alt",
  PAGEDOWN: "PageDown",
  PAGEUP: "PageUp",
  PGDN: "PageDown",
  PGUP: "PageUp",
  RETURN: "Enter",
  RIGHT: "ArrowRight",
  SHIFT: "Shift",
  SPACE: "Space",
  TAB: "Tab",
  UP: "ArrowUp",
  WIN: "Meta",
  WINDOWS: "Meta",
} as const;
const FRAME_IDS = new WeakMap<Frame, string>();
const CHALLENGE_BLOCKED_ACTIONS = new Set<BrowserAction["action"]>([
  "click", "input", "select_dropdown", "scroll", "scroll_to_bottom", "send_keys",
  "upload_file", "evaluate", "run_script", "hover", "press_and_hold",
  "set_cookie", "delete_cookies", "set_storage", "clear_storage",
]);
const SNAPSHOT_AFTER_ACTIONS = new Set<BrowserAction["action"]>([
  "navigate", "click", "input", "select_dropdown", "scroll", "send_keys", "go_back", "go_forward", "reload",
]);
const DOM_MUTATING_ACTIONS = new Set<BrowserAction["action"]>([
  "click", "input", "select_dropdown", "scroll", "scroll_to_bottom", "send_keys", "upload_file", "set_storage", "clear_storage",
]);

export class BrowserService {
  private readonly sessionId = randomUUID();
  private lastActivityAt = Date.now();
  private browser: Browser | undefined;
  private ownsBrowser = false;
  private shuttingDown = false;
  private lifecycleGeneration = 0;
  private connectionPromise: Promise<Browser> | undefined;
  private closePromise: Promise<void> | undefined;
  private shutdownOutcomePromise: Promise<BrowserShutdownOutcome> | undefined;
  private browserClosePromise: Promise<BrowserShutdownOutcome> | undefined;
  private connectionSettlementPromise: Promise<void> | undefined;
  private interruptedBrowserShutdown: Promise<boolean> | undefined;
  private failedBrowserShutdown: { browser: Browser; owned: boolean } | undefined;
  private browserShutdownFailure = false;
  private recoveryRequired = false;
  private recoveryPromise: Promise<void> | undefined;
  private readonly shutdownController = new AbortController();
  private activeOperationController: AbortController | undefined;
  private currentPageId: string | undefined;
  private sessionGeneration = 0;
  private readonly states = new Map<string, PageState>();
  private readonly configuredDownloadContexts = new WeakSet<object>();
  private readonly ids = new WeakMap<Page, string>();
  private readonly targetGuardSessions = new Map<string, TargetGuardSession>();
  private readonly unguardedTargetSessions = new Set<string>();
  private readonly pendingTargetGuardSessions = new Map<string, CDPSession>();
  private readonly pendingTargetGuardInfos = new Map<string, { targetId: string; targetType: string }>();
  private targetGuardUnavailable = false;
  private targetGuardConnection: TargetGuardConnection | undefined;
  private targetGuardConnectionListener: ((value: unknown) => void) | undefined;
  private targetGuardRawConnectionListener: ((value: unknown) => void) | undefined;
  private targetGuardDetachedListener: ((value: unknown) => void) | undefined;
  private targetGuardOriginalEmit: ((event: string, value: unknown) => boolean) | undefined;
  private targetGuardWrappedEmit: ((event: string, value: unknown) => boolean) | undefined;
  private operationTail = Promise.resolve();
  private queuedOperations = 0;
  private readonly benchmarkCounters: BenchmarkCounters | undefined = process.env.SMOOTH_OPERATOR_BENCHMARK_COUNTERS === "true"
    ? { browserOperations: 0, pageLookups: 0, pageEnumerations: 0, pageEvaluations: 0, cdpCommands: 0 }
    : undefined;
  constructor(
    private readonly config: ServerConfig,
    private readonly policy: SecurityPolicy,
    private readonly logger: Logger,
    private readonly dependencies: BrowserServiceDependencies = {},
  ) {}

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const closing = this.shutdownOutcome().then(() => undefined);
    this.closePromise = closing;
    return closing;
  }

  async shutdownOutcome(): Promise<BrowserShutdownOutcome> {
    if (this.shutdownOutcomePromise) {
      return this.shutdownOutcomePromise;
    }
    const closing = this.closeRuntime();
    this.shutdownOutcomePromise = closing;
    return closing;
  }

  private async closeRuntime(): Promise<BrowserShutdownOutcome> {
    if (this.shuttingDown) {
      return { closed: false, owned: false, succeeded: true };
    }
    this.shuttingDown = true;
    this.lifecycleGeneration += 1;
    this.shutdownController.abort();
    this.activeOperationController?.abort();
    // Shutdown must be able to interrupt a long wait or dialog-blocked action;
    // waiting behind the operation queue could leave SIGTERM stuck for the
    // entire action timeout.
    const connectionSettled = await settlesWithinTimeout(this.connectionPromise, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS);
    const lateConnectionSettled = await settlesWithinTimeout(this.connectionSettlementPromise, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS);
    const interruptedShutdown = this.interruptedBrowserShutdown;
    const interruptedSucceeded = interruptedShutdown
      ? (await settleWithTimeout(interruptedShutdown, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS).catch(() => undefined)) === true
      : true;
    const browserResult = await this.closeBrowser();
    return { ...browserResult, succeeded: browserResult.succeeded && connectionSettled && lateConnectionSettled && interruptedSucceeded };
  }

  connectionStatus(): { connected: boolean; owned: boolean; trackedPages: number; queuedOperations: number; currentPageId: string | null; recoveryRequired: boolean; benchmarkCounters?: BenchmarkCounters } {
    return {
      connected: Boolean(this.browser),
      owned: this.ownsBrowser,
      trackedPages: this.states.size,
      queuedOperations: this.queuedOperations,
      currentPageId: this.currentPageId ?? null,
      recoveryRequired: this.recoveryRequired,
      ...(this.benchmarkCounters ? { benchmarkCounters: { ...this.benchmarkCounters } } : {}),
    };
  }

  sessionSummary(): { session_id: string; active: boolean; owned: boolean; trackedPages: number; queuedOperations: number; currentPageId: string | null; recoveryRequired: boolean; lastActivityAt: string } {
    const status = this.connectionStatus();
    return { session_id: this.sessionId, active: status.connected, owned: status.owned, trackedPages: status.trackedPages, queuedOperations: status.queuedOperations, currentPageId: status.currentPageId, recoveryRequired: this.recoveryRequired, lastActivityAt: new Date(this.lastActivityAt).toISOString() };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const discovered = this.config.browser.executablePath ? undefined : findChromeExecutable();
    const executablePath = this.config.browser.executablePath ?? discovered?.path;
    const endpoint = await this.probeManagedEndpoint();
    const browser = endpoint.version?.Browser;
    return {
      mode: this.config.browser.mode,
      executablePath: executablePath ?? null,
      ...(executablePath ? {} : { searchedPaths: chromeExecutableSearchPaths().slice(0, 128) }),
      userDataDir: this.config.browser.userDataDir ?? null,
      endpoint: {
        state: endpoint.state,
        ...(endpoint.state === "live" && endpoint.version ? {
          version: {
            Browser: endpoint.version.Browser,
            "Protocol-Version": endpoint.version["Protocol-Version"],
            webSocketDebuggerUrl: redactWebSocketEndpoint(endpoint.version.webSocketDebuggerUrl),
          },
        } : {}),
      },
      posture: browser?.includes("HeadlessChrome")
        ? "Headless Chrome was reported by the endpoint; this is informational only."
        : browser
          ? "A headed Chrome endpoint was reported; this is informational only."
          : "No live browser endpoint was reported.",
    };
  }

  async closeSession(sessionId: string): Promise<{ closed: boolean; session_id: string }> {
    if (sessionId !== this.sessionId) {
      throw new AppError("SESSION_NOT_FOUND", `Browser session '${sessionId}' was not found.`);
    }
    // Invalidate requests that were queued before this control-plane close.
    // New requests are allowed to establish a fresh browser connection after
    // the close has completed, but stale queued work must never run against it.
    this.sessionGeneration += 1;
    // Session close is a control-plane operation. It must be able to cancel a
    // queued/long-running browser action instead of waiting behind it forever.
    this.activeOperationController?.abort();
    let interruptedCleanupFailed = false;
    if (this.interruptedBrowserShutdown) {
      const cleanup = await settleWithTimeout(this.interruptedBrowserShutdown, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS);
      if (cleanup === undefined) {
        this.recoveryRequired = true;
        return { closed: false, session_id: this.sessionId };
      }
      if (cleanup === true) {
        this.interruptedBrowserShutdown = undefined;
      } else {
        // The interrupted close has settled but failed.  Keep its browser
        // handle so closeBrowser() can retry it through the control plane.
        interruptedCleanupFailed = true;
      }
    }
    const result = await this.closeBrowser();
    if (interruptedCleanupFailed && result.succeeded) {
      this.interruptedBrowserShutdown = undefined;
    }
    this.recoveryRequired = !result.succeeded;
    return { closed: result.closed, session_id: this.sessionId };
  }

  private async closeBrowser(): Promise<BrowserShutdownOutcome> {
    if (this.browserClosePromise) {
      return this.browserClosePromise;
    }
    const closing = this.closeBrowserUnlocked();
    this.browserClosePromise = closing;
    void closing.then(
      () => {
        if (this.browserClosePromise === closing) {
          this.browserClosePromise = undefined;
        }
      },
      () => {
        if (this.browserClosePromise === closing) {
          this.browserClosePromise = undefined;
        }
      },
    );
    return closing;
  }

  private async closeBrowserUnlocked(): Promise<BrowserShutdownOutcome> {
    this.lifecycleGeneration += 1;
    const pendingConnection = this.connectionPromise;
    if (pendingConnection) {
      if (this.shuttingDown) {
        await settlesWithinTimeout(pendingConnection, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS);
      } else {
        await pendingConnection.catch(() => undefined);
      }
    }
    if (this.connectionPromise === pendingConnection) {
      this.connectionPromise = undefined;
    }
    const browser = this.browser ?? this.failedBrowserShutdown?.browser;
    const owned = this.browser ? this.ownsBrowser : this.failedBrowserShutdown?.owned ?? false;
    this.failedBrowserShutdown = undefined;
    this.detachTargetGuard();
    this.browser = undefined;
    this.ownsBrowser = false;
    this.retireAllStates();
    if (!browser) {
      const succeeded = !this.browserShutdownFailure;
      this.recoveryRequired = !succeeded;
      return { closed: false, owned: false, succeeded };
    }
    let succeeded = true;
    if (owned) {
      await Promise.resolve().then(() => browser.close()).catch((error: unknown) => {
        succeeded = false;
        this.logger.warn("Browser close failed", { error: String(error) });
      });
    } else {
      await Promise.resolve().then(() => browser.disconnect()).catch((error: unknown) => {
        succeeded = false;
        this.logger.warn("Browser disconnect failed", { error: String(error) });
      });
    }
    if (!succeeded) {
      this.browserShutdownFailure = true;
      this.failedBrowserShutdown = { browser, owned };
      this.recoveryRequired = true;
    } else {
      this.browserShutdownFailure = false;
      this.recoveryRequired = false;
    }
    return { closed: true, owned, succeeded };
  }

  async listTabs(signal?: AbortSignal): Promise<BrowserTab[]> {
    return this.withOperationLock(signal, (operationSignal) => this.listTabsUnlocked(operationSignal), this.config.browser.actionTimeoutMs, this.config.browser.actionTimeoutMs);
  }

  private async listTabsUnlocked(signal?: AbortSignal): Promise<BrowserTab[]> {
    const generation = this.lifecycleGeneration;
    throwIfAborted(signal);
    const browser = await this.ensureBrowser(signal);
    let pages: Page[];
    try {
      if (this.benchmarkCounters) {
        this.benchmarkCounters.pageEnumerations += 1;
      }
      pages = await browser.pages();
    } catch (error) {
      if (!this.isCurrentBrowser(browser, generation)) {
        throw this.browserLifecycleError();
      }
      throw normalizeBrowserOperationError(error, signal);
    }
    if (!this.isCurrentBrowser(browser, generation)) {
      throw this.browserLifecycleError();
    }
    const activePages = new Set(pages);
    for (const [, state] of this.states) {
      throwIfAborted(signal);
      if (isPageClosed(state.page) || !activePages.has(state.page)) {
        this.retireState(state);
      }
    }
    const tabs: BrowserTab[] = [];
    for (const [index, page] of pages.entries()) {
      throwIfAborted(signal);
      if (isPageClosed(page)) {
        continue;
      }
      const state = this.stateFor(page);
      try {
        await this.configurePage(state, signal);
      } catch (error) {
        await this.disposeStalePageState(state);
        throw error;
      }
      let title = "";
      try {
        title = await page.title();
      } catch {
        title = "";
      }
      try {
        await this.assertCurrentPageAllowed(page);
        tabs.push({ index, id: state.id, tab_id: tabIdentifier(state.id, this.states), url: safeUrl(page.url()), title: wrapUntrustedText("tab_title", redactSecretPlaceholders(title.slice(0, 1_000)), 1_000), active: state.id === this.currentPageId || (!this.currentPageId && tabs.length === 0) });
      } catch (error) {
        this.logger.warn("Existing tab hidden by navigation policy", { pageId: state.id, code: error instanceof AppError ? error.code : "POLICY_ERROR" });
        tabs.push({ index, id: state.id, tab_id: tabIdentifier(state.id, this.states), url: "[BLOCKED_BY_POLICY]", title: "[BLOCKED_BY_POLICY]", active: state.id === this.currentPageId || (!this.currentPageId && tabs.length === 0) });
      }
    }
    if (!this.currentPageId && tabs[0]) {
      this.currentPageId = tabs[0].id;
    }
    return tabs.map((tab) => ({ ...tab, active: tab.id === this.currentPageId }));
  }

  async snapshot(options: { pageId?: string; frameId?: string; includeFrames?: "none" | "metadata"; includeScreenshot?: boolean; fullPage?: boolean; maxDimension?: number; maxChars?: number; signal?: AbortSignal } = {}): Promise<PageSnapshot> {
    return this.withOperationLock(options.signal, (signal) => this.snapshotUnlocked({ ...options, signal }), this.config.browser.actionTimeoutMs, this.config.browser.actionTimeoutMs);
  }

  private async snapshotUnlocked(options: { pageId?: string; frameId?: string; includeFrames?: "none" | "metadata"; includeScreenshot?: boolean; fullPage?: boolean; maxDimension?: number; maxChars?: number; signal?: AbortSignal } = {}): Promise<PageSnapshot> {
    if (this.benchmarkCounters) {
      this.benchmarkCounters.pageEvaluations += 1;
    }
    throwIfAborted(options.signal);
    this.assertNoPendingDialog(options.pageId);
    const state = await this.pageState(options.pageId, options.signal);
    await this.configurePage(state, options.signal);
    await this.assertCurrentPageAllowed(state.page);
    const frame = await this.frameFor(state, options.frameId);
    const domRevisionAtStart = state.domRevision;
    const maxChars = Math.min(options.maxChars ?? 40_000, this.config.browser.maxHtmlChars);
    const result: SnapshotEvaluation = await frame.evaluate((limit) => {
      const uniqueIds = new Set<string>();
      const duplicateIds = new Set<string>();
      for (const element of Array.from(document.querySelectorAll("[id]"))) {
        const id = (element as HTMLElement).id;
        if (!id) {
          continue;
        }
        if (uniqueIds.has(id)) {
          uniqueIds.delete(id);
          duplicateIds.add(id);
        } else if (!duplicateIds.has(id)) {
          uniqueIds.add(id);
        }
      }
      const interactiveSelector = "a,button,input,select,textarea,[role], [onclick], [tabindex], label[for], summary,[contenteditable=true]";
      const allInteractive = Array.from(document.querySelectorAll(interactiveSelector));
      const visibleInteractive: Element[] = [];
      let visibleInteractiveCount = 0;
      for (const element of allInteractive) {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
          continue;
        }
        visibleInteractiveCount += 1;
        if (visibleInteractive.length < 250) {
          visibleInteractive.push(element);
        }
      }
      const interactive = visibleInteractive
        .map((element, index) => {
          const htmlElement = element as HTMLElement & { disabled?: boolean; type?: string };
          const rect = htmlElement.getBoundingClientRect();
          let selector = "body";
          if (htmlElement.id && uniqueIds.has(htmlElement.id) && !duplicateIds.has(htmlElement.id)) {
            selector = `#${CSS.escape(htmlElement.id)}`;
          } else {
            const parts: string[] = [];
            let current: Element | null = element;
            while (current && current !== document.body && parts.length < 8) {
              const tag = current.tagName.toLowerCase();
              const parent: HTMLElement | null = current.parentElement;
              if (!parent) {
                parts.unshift(tag);
                break;
              }
              const currentTagName = current.tagName;
              const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === currentTagName);
              const siblingIndex = siblings.indexOf(current) + 1;
              parts.unshift(`${tag}:nth-of-type(${siblingIndex})`);
              current = parent;
            }
            selector = parts.join(" > ") || "body";
          }
          const anchor = element.closest("a") as HTMLAnchorElement | null;
          const signature = [
            element.tagName.toLowerCase(),
            element.getAttribute("role") ?? "",
            element.getAttribute("aria-label") ?? "",
            htmlElement.type ?? "",
            (htmlElement.innerText || element.getAttribute("value") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
            anchor?.href ?? "",
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
          ].join("\u001f");
          return {
            ref: `e${index + 1}`,
            index,
            selector,
            signature,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") ?? undefined,
            text: /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)
              ? (element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 500)
              : (htmlElement.innerText || "").trim().slice(0, 500),
            ariaLabel: element.getAttribute("aria-label") ?? undefined,
            type: htmlElement.type ?? undefined,
            valuePresent: /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) && "value" in htmlElement && String((htmlElement as HTMLInputElement).value ?? "").length > 0,
            disabled: Boolean(htmlElement.disabled || element.getAttribute("aria-disabled") === "true"),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          };
        });
      const root = document.body;
      const fullText = root?.innerText ?? "";
      const text = fullText.slice(0, limit);
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .map((heading) => (heading.textContent ?? "").trim())
        .filter(Boolean)
        .slice(0, 100);
      return {
        text,
        textTruncated: fullText.length > limit,
        headings,
        interactive,
        interactiveTruncated: visibleInteractiveCount > visibleInteractive.length,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        readyState: document.readyState,
        scroll: {
          x: window.scrollX,
          y: window.scrollY,
          maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        },
      };
    }, maxChars);
    throwIfAborted(options.signal);
    const snapshotId = randomUUID();
    let frameId: string;
    const [title, frames, screenshot] = await Promise.all([
      frame.title().catch(() => ""),
      options.includeFrames === "metadata" ? this.listFrames(state) : Promise.resolve(undefined),
      options.includeScreenshot
        ? this.screenshotBase64(state.page, options.fullPage ?? false, this.config.browser.maxScreenshotBytes, "png", 80, options.maxDimension)
        : Promise.resolve(undefined),
    ]);
    throwIfAborted(options.signal);
    const pageUrl = safeUrl(state.page.url());
    this.assertStateLive(state);
    if (state.domRevision !== domRevisionAtStart || isFrameDetached(frame)) {
      throw new AppError("STALE_SNAPSHOT", "The page changed while its snapshot was being collected. Capture a fresh snapshot and retry.", { retryable: true });
    }
    try {
      frameId = framePath(frame);
    } catch {
      throw new AppError("STALE_SNAPSHOT", "The page changed while its snapshot was being collected. Capture a fresh snapshot and retry.", { retryable: true });
    }
    state.snapshotId = snapshotId;
    state.domRevision += 1;
    state.refs = new Map(result.interactive.map((element) => [element.ref, {
      selector: element.selector,
      signature: element.signature,
      snapshotId,
      frameId,
      index: element.index,
    }]));
    state.snapshotInteractive = result.interactive.map(({ signature: _signature, ...element }) => ({
      ...element,
      text: wrapUntrustedText("interactive_text", redactSecretPlaceholders(element.text), 500),
      ...(element.ariaLabel ? { ariaLabel: wrapUntrustedText("interactive_label", redactSecretPlaceholders(element.ariaLabel), 500) } : {}),
    }));
    return {
      pageId: state.id,
      frameId,
      snapshotId,
      domRevision: state.domRevision,
      url: pageUrl,
      title: wrapUntrustedText("page_title", redactSecretPlaceholders(title.slice(0, 1_000)), 1_000),
      text: wrapUntrustedText("page_text", redactSecretPlaceholders(result.text), maxChars),
      textTruncated: result.textTruncated,
      headings: result.headings.map((heading) => wrapUntrustedText("page_heading", redactSecretPlaceholders(heading), 500)),
      interactive: state.snapshotInteractive,
      interactiveTruncated: result.interactiveTruncated,
      viewport: result.viewport,
      document: result.document,
      readyState: result.readyState,
      scroll: result.scroll,
      ...(frames ? { frames } : {}),
      ...(screenshot ? { screenshotBase64: screenshot.screenshotBase64, screenshot: screenshot.metadata } : {}),
    };
  }

  async execute(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    if (this.benchmarkCounters) {
      this.benchmarkCounters.browserOperations += 1;
    }
    if (this.recoveryRequired && action.action !== "close_browser") {
      throw new AppError("BROWSER_RECOVERY_REQUIRED", "Browser recovery is required before browser work can continue. Call browser_close_session and retry.", { retryable: true, details: { hint: "Call browser_close_session and retry after cleanup succeeds." } });
    }
    // A page dialog blocks Puppeteer operations. Let the dialog tool resolve a
    // pending dialog even while the operation that opened it is still waiting.
    if (isDialogAction(action)) {
      const pendingState = this.dialogState(action.pageId);
      if (pendingState?.dialogs.length) {
        return this.executeDialogAction(pendingState, action, combineSignals(signal, this.shutdownController.signal));
      }
    }
    if (!isDialogAction(action) && action.action !== "list_tabs" && action.action !== "close_browser") {
      this.assertNoPendingDialog(action.pageId);
    }
    const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
    // wait_for_human resolves with its own status (timed_out / resolved /
    // cancelled) after `timeoutMs`. Give the operation lock a buffer so a
    // borderline-slow challenge probe cannot abort it with BROWSER_TIMEOUT
    // before the internal deadline elapses and returns a status object.
    const budgetMs = action.action === "wait_for_human" ? timeoutMs + 5_000 : timeoutMs;
    return this.withOperationLock(signal, async (operationSignal) => {
      const result = await this.executeUnlocked(action, operationSignal);
      if (DOM_MUTATING_ACTIONS.has(action.action)) {
        this.invalidateActionSnapshot(action, result);
      }
      if (!action.includeSnapshot || !SNAPSHOT_AFTER_ACTIONS.has(action.action)) {
        return result;
      }
      return this.attachOptionalSnapshot(action, result, operationSignal);
    }, budgetMs, budgetMs);
  }

  private invalidateActionSnapshot(action: BrowserAction, result: unknown): void {
    const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
    const resultPageId = typeof record?.pageId === "string"
      ? record.pageId
      : typeof record?.openedPageId === "string"
        ? record.openedPageId
        : action.pageId ?? this.currentPageId;
    const state = resultPageId ? this.states.get(resultPageId) : undefined;
    if (!state || state.disposed) {
      return;
    }
    state.domRevision += 1;
    state.refs.clear();
    state.snapshotId = undefined;
    state.snapshotInteractive = undefined;
  }

  private async attachOptionalSnapshot(action: BrowserAction, result: unknown, signal?: AbortSignal): Promise<unknown> {
    const record: Record<string, unknown> = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Record<string, unknown>) } : { result };
    const pageId = typeof record.openedPageId === "string"
      ? record.openedPageId
      : typeof record.pageId === "string"
        ? record.pageId
        : this.currentPageId;
    try {
      record.snapshot = await this.snapshotUnlocked({ pageId, frameId: action.frameId, maxChars: 8_000, signal });
    } catch (error) {
      record.snapshot = null;
      record.snapshotError = boundedSnapshotError(error);
    }
    return record;
  }

  /** Execute already-normalized actions while holding one browser-operation lock. */
  async executeBatch(actions: BrowserAction[], options: { confirmDestructive?: boolean; includeSnapshot?: boolean } = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.benchmarkCounters) {
      this.benchmarkCounters.browserOperations += actions.length;
    }
    if (this.recoveryRequired) {
      throw new AppError("BROWSER_RECOVERY_REQUIRED", "Browser recovery is required before browser work can continue. Call browser_close_session and retry.", { retryable: true, details: { hint: "Call browser_close_session and retry after cleanup succeeds." } });
    }
    const actionCount = actions.length;
    return this.withOperationLock(signal, (operationSignal) => this.executeBatchUnlocked(actions, options, operationSignal), this.config.browser.actionTimeoutMs * Math.max(1, actionCount), this.config.browser.actionTimeoutMs * Math.max(1, actionCount));
  }

  private async executeUnlocked(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    if (!isDialogAction(action) && action.action !== "list_tabs" && action.action !== "close_browser") {
      this.assertNoPendingDialog(action.pageId);
    }
    if (action.action === "evaluate" && !this.config.security.allowEval) {
      throw new AppError("EVALUATE_DISABLED", "Page JavaScript execution is disabled by server configuration.");
    }
    throwIfAborted(signal);

    switch (action.action) {
      case "list_tabs":
        return this.listTabsUnlocked(signal);
      case "close_browser":
        return this.closeBrowser();
      case "run_script":
        return this.executeScript(requireField(action.script ?? action.code, "script"), signal, action.confirmDestructive === true);
      default:
      return this.executeOnPage(action, signal);
  }
  }

  private async executeOnPage(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    if (action.action === "navigate") {
      const targetUrl = requireField(action.url, "url");
      const newTab = action.newTab ?? action.new_tab;
      if (newTab && action.pageId) {
        throw new AppError("INVALID_ACTION", "newTab navigation cannot also target an existing pageId.");
      }
      const url = await this.policy.assertNavigationAllowedAsync(targetUrl);
      const state = newTab ? await this.newPageState(signal) : await this.pageState(action.pageId, signal);
      await this.configurePage(state, signal);
      const navigationGeneration = this.beginNavigation(state);
      try {
        await state.page.goto(url.toString(), { waitUntil: action.waitUntil ?? "domcontentloaded", timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
        this.throwNavigationError(state, navigationGeneration);
        await this.policy.assertNavigationAllowedAsync(state.page.url());
      } catch (error) {
        const navigationError = this.takeNavigationError(state, navigationGeneration);
        if (newTab) {
          await this.disposePageState(state);
        }
        throw navigationError ?? error;
      } finally {
        if (state.activeNavigationGeneration === navigationGeneration) {
          state.activeNavigationGeneration = undefined;
        }
      }
      this.assertStateLive(state);
      this.currentPageId = state.id;
      return { pageId: state.id, url: safeUrl(state.page.url()), title: wrapUntrustedText("page_title", redactSecretPlaceholders((await state.page.title().catch(() => "")).slice(0, 1_000)), 1_000) };
    }

    if (action.action === "close_tab") {
      return this.closeTabAction(action, signal);
    }

    const state = await this.pageState(action.pageId, signal);
    const page = state.page;
    await this.assertCurrentPageAllowed(page);
    if (state.challengeActive && isChallengeBlockedAction(action.action)) {
      throw new AppError("CHALLENGE_REQUIRES_HUMAN", "A verified browser challenge is active. Complete it in the browser, then call browser_wait_for_human before continuing.", {
        retryable: true,
        details: { pageId: state.id, action: action.action },
      });
    }
    this.assertSnapshotForAction(state, action);
    const frame = await this.frameFor(state, action.frameId);
    throwIfAborted(signal);

    switch (action.action) {
      case "click": {
        const navigationGeneration = this.beginNavigation(state);
        try {
        let monitor: ClickMonitorResult = { navigated: false, urlChanged: false };
        const coordinateX = action.coordinateX ?? action.coordinate_x;
        const coordinateY = action.coordinateY ?? action.coordinate_y;
        const clickInNewTab = action.newTab ?? action.new_tab;
        if (coordinateX !== undefined || coordinateY !== undefined) {
          if (coordinateX === undefined || coordinateY === undefined) {
            throw new AppError("INVALID_ACTION", "coordinateX and coordinateY must be provided together.");
          }
          if (clickInNewTab) {
            throw new AppError("INVALID_ACTION", "newTab is supported for link targets, not coordinate clicks.");
          }
          const bounds = page.viewport() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
          if (coordinateX < 0 || coordinateY < 0 || coordinateX >= bounds.width || coordinateY >= bounds.height) {
            throw new AppError("COORDINATE_OUT_OF_BOUNDS", `The click coordinate (${coordinateX}, ${coordinateY}) is outside the ${bounds.width}x${bounds.height} viewport.`);
          }
          const coordinateTarget = await page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y);
            if (!element) {
              return undefined;
            }
            const clickable = element.closest("a,button,input,select,textarea,[role=button]") ?? element;
            const htmlElement = clickable as HTMLElement & { type?: string; value?: string };
            return {
              tag: clickable.tagName.toLowerCase(),
              type: htmlElement.type?.toLowerCase() ?? "",
              role: clickable.getAttribute("role") ?? "",
              label: [clickable.textContent, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
            };
          }, { x: coordinateX, y: coordinateY });
          if (coordinateTarget) {
            this.assertClickTargetSafe(coordinateTarget);
          }
          monitor = await this.runClickAndMonitor(page, () => page.mouse.click(coordinateX, coordinateY, { button: action.button ?? "left", count: action.clickCount ?? 1 }), signal);
        } else {
          const target = targetForAction(action, "target");
          if (clickInNewTab) {
            if (action.frameId && action.frameId !== "main") {
              throw new AppError("FRAME_ACTION_UNSUPPORTED", "Opening a new tab from a child frame requires an explicit browser_navigate call.");
            }
            const opened = await this.openLinkInNewTab(state, target, signal);
            if (opened) {
              return opened;
            }
          }
          monitor = await this.clickTarget(state, target, action.button ?? "left", action.clickCount ?? 1, signal, frame);
        }
        await this.throwPendingNavigationError(state, signal, navigationGeneration);
        return { clicked: true, pageId: state.id, navigated: monitor.navigated, urlChanged: monitor.urlChanged, ...(monitor.url ? { url: safeUrl(monitor.url) } : {}) };
        } finally {
          if (state.activeNavigationGeneration === navigationGeneration) {
            state.activeNavigationGeneration = undefined;
          }
        }
      }
      case "input":
        return {
          input: true,
          pageId: state.id,
          ...(await this.inputTarget(
            state,
            targetForAction(action, "target"),
            requirePresentField(action.text ?? action.value, "text"),
            action.clear ?? !action.append,
            action.verify ?? false,
            frame,
            signal,
          )),
        };
      case "select_dropdown": {
        const selector = await this.selectorFor(state, targetForAction(action, "target"), action.frameId);
        const value = requireField(action.optionValue ?? action.value, "optionValue");
        const selected = await frame.select(selector, value);
        return { selected, pageId: state.id };
      }
      case "scroll": {
        const amount = action.amount ?? 600;
        const direction = action.direction === "up" || action.direction === "left" ? -1 : 1;
        await frame.evaluate((delta) => window.scrollBy(delta.x, delta.y), { x: action.direction === "left" || action.direction === "right" ? amount * direction : 0, y: action.direction === "up" || action.direction === "down" ? amount * direction : 0 });
        return { scrolled: true, y: await frame.evaluate(() => window.scrollY), frameId: framePath(frame) };
      }
      case "scroll_to_bottom": {
        if (action.frameId && action.frameId !== "main") {
          throw new AppError("FRAME_ACTION_UNSUPPORTED", "Use browser_scroll with frameId for a child frame; page-bottom scrolling targets the top-level document.");
        }
        const maxScrolls = action.maxScrolls ?? 20;
        const scrollDeadline = Date.now() + (action.timeoutMs ?? this.config.browser.actionTimeoutMs);
        const initialPosition = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        let iterations = 0;
        let previousHeight = -1;
        for (; iterations < maxScrolls; iterations += 1) {
          throwIfAborted(signal);
          if (scrollDeadline - Date.now() <= 0) {
            throw new AppError("WAIT_TIMEOUT", "Scroll-to-bottom exceeded its action timeout.", { retryable: true });
          }
          const before = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, y: window.scrollY, viewport: window.innerHeight }));
          await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior }));
          const remaining = scrollDeadline - Date.now();
          if (remaining <= 0) {
            throw new AppError("WAIT_TIMEOUT", "Scroll-to-bottom exceeded its action timeout.", { retryable: true });
          }
          await page.waitForNetworkIdle({ idleTime: 500, timeout: Math.min(remaining, 5_000), signal }).catch(() => {
            throwIfAborted(signal);
            return undefined;
          });
          const after = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, y: window.scrollY, viewport: window.innerHeight }));
          if (after.y + after.viewport >= after.height - 2 && after.height === before.height && after.height === previousHeight) {
            if (action.restoreTop) {
              await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior }), initialPosition);
            }
            return { scrolled: true, atBottom: true, iterations: iterations + 1, height: after.height, scrollY: after.y, restored: action.restoreTop === true };
          }
          previousHeight = after.height;
        }
        const final = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, y: window.scrollY, viewport: window.innerHeight }));
        if (action.restoreTop) {
          await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior }), initialPosition);
        }
        return { scrolled: true, atBottom: final.y + final.viewport >= final.height - 2, iterations, height: final.height, scrollY: final.y, restored: action.restoreTop === true };
      }
      case "send_keys":
        await this.sendKeys(page, action.keys ?? [requireField(action.key, "key")], signal);
        return { sent: true };
      case "switch_tab": {
        const targetId = requireField(action.pageId ?? action.target, "pageId");
        const targetState = await this.pageState(targetId, signal);
        await targetState.page.bringToFront();
        this.assertStateLive(targetState);
        this.currentPageId = targetId;
        return { pageId: targetId };
      }
      case "go_back":
        {
          const navigationGeneration = this.beginNavigation(state);
          let changed = true;
          try {
            let response;
            try {
              response = await page.goBack({ waitUntil: action.waitUntil ?? "domcontentloaded", timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
            } catch (error) {
              const navigationError = this.takeNavigationError(state, navigationGeneration);
              if (navigationError) {
                throw navigationError;
              }
              if (isNoHistoryNavigationError(error)) {
                changed = false;
              } else {
                throw error;
              }
            }
            if (!response) {
              this.throwNavigationError(state, navigationGeneration);
              changed = false;
            }
            if (changed) {
              this.throwNavigationError(state, navigationGeneration);
            }
          } finally {
            if (state.activeNavigationGeneration === navigationGeneration) {
              state.activeNavigationGeneration = undefined;
            }
          }
          await this.assertCurrentPageAllowed(page);
          return { url: safeUrl(page.url()), ...(changed ? {} : { changed: false }) };
        }
      case "go_forward":
        {
          const navigationGeneration = this.beginNavigation(state);
          let changed = true;
          try {
            let response;
            try {
              response = await page.goForward({ waitUntil: action.waitUntil ?? "domcontentloaded", timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
            } catch (error) {
              const navigationError = this.takeNavigationError(state, navigationGeneration);
              if (navigationError) {
                throw navigationError;
              }
              if (isNoHistoryNavigationError(error)) {
                changed = false;
              } else {
                throw error;
              }
            }
            if (!response) {
              this.throwNavigationError(state, navigationGeneration);
              changed = false;
            }
            if (changed) {
              this.throwNavigationError(state, navigationGeneration);
            }
          } finally {
            if (state.activeNavigationGeneration === navigationGeneration) {
              state.activeNavigationGeneration = undefined;
            }
          }
          await this.assertCurrentPageAllowed(page);
          return { url: safeUrl(page.url()), ...(changed ? {} : { changed: false }) };
        }
      case "reload":
        {
        const navigationGeneration = this.beginNavigation(state);
        try {
          const response = await page.reload({ waitUntil: action.waitUntil ?? "domcontentloaded", timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
          this.throwNavigationError(state, navigationGeneration);
          if (!response) {
            return { url: safeUrl(page.url()), reloaded: false, title: wrapUntrustedText("page_title", redactSecretPlaceholders((await page.title().catch(() => "")).slice(0, 1_000)), 1_000) };
          }
        } catch (error) {
          throw this.takeNavigationError(state, navigationGeneration) ?? error;
        } finally {
          if (state.activeNavigationGeneration === navigationGeneration) {
            state.activeNavigationGeneration = undefined;
          }
        }
        await this.assertCurrentPageAllowed(page);
        return { url: safeUrl(page.url()), title: wrapUntrustedText("page_title", redactSecretPlaceholders((await page.title().catch(() => "")).slice(0, 1_000)), 1_000) };
        }
      case "wait":
        await wait(action.milliseconds ?? 500, signal);
        return { waitedMs: action.milliseconds ?? 500 };
      case "wait_for_element": {
        const selector = targetForAction(action, "selector");
        const resolvedSelector = await this.selectorFor(state, selector, action.frameId);
        const waitState = action.state ?? "visible";
        await waitForElementState(frame, resolvedSelector, waitState, action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal);
        return { found: true, selector, state: waitState };
      }
      case "wait_for_text": {
        const text = requireField(action.text ?? action.query, "text");
        const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
        try {
          await frame.waitForFunction((needle) => document.body?.innerText.includes(needle), { timeout: timeoutMs, signal }, text);
        } catch (error) {
          if (isPuppeteerTimeoutError(error)) {
            throw new AppError("WAIT_TIMEOUT", `The text '${text.slice(0, 200)}' did not appear within ${timeoutMs}ms.`, { retryable: true });
          }
          throw error;
        }
        return { found: true, text };
      }
      case "wait_for_url": {
        const pattern = requireField(action.url ?? action.value, "url");
        const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
        await this.waitForUrlPattern(page, pattern, timeoutMs, signal);
        return { url: safeUrl(page.url()) };
      }
      case "wait_for_network_idle":
        await page.waitForNetworkIdle({ idleTime: 500, timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
        return { idle: true };
      case "enable_network_log":
        state.networkEnabled = true;
        return { enabled: true };
      case "disable_network_log":
        state.networkEnabled = false;
        return { enabled: false };
      case "get_network_log":
        return { entries: untrustedLogEntries(state.network.slice(-MAX_LOG_ENTRIES)) };
      case "clear_network_log":
        state.network = [];
        return { cleared: true };
      case "getclear_network_log": {
        const entries = untrustedLogEntries(state.network.slice(-MAX_LOG_ENTRIES));
        state.network = [];
        return { entries, cleared: true };
      }
      case "enable_console_log":
        state.consoleEnabled = true;
        return { enabled: true };
      case "disable_console_log":
        state.consoleEnabled = false;
        return { enabled: false };
      case "get_console_log":
        return { entries: untrustedLogEntries(state.console.slice(-MAX_LOG_ENTRIES)) };
      case "clear_console_log":
        state.console = [];
        return { cleared: true };
      case "getclear_console_log": {
        const entries = untrustedLogEntries(state.console.slice(-MAX_LOG_ENTRIES));
        state.console = [];
        return { entries, cleared: true };
      }
      case "find_text": {
        const text = requireField(action.text ?? action.query, "text");
        const match = await frame.evaluate((needle) => {
          const elements = Array.from(document.querySelectorAll("body *"));
          const element = elements.find((candidate) => (candidate.textContent ?? "").includes(needle));
          element?.scrollIntoView({ block: "center" });
          return element ? { tag: element.tagName.toLowerCase(), text: (element.textContent ?? "").trim().slice(0, 1_000) } : undefined;
        }, text);
        if (!match) {
          throw new AppError("TEXT_NOT_FOUND", `Text '${text.slice(0, 100)}' was not found.`);
        }
        return { ...match, text: wrapUntrustedText("found_text", redactSecretPlaceholders(match.text), 1_000) };
      }
      case "extract": {
        if (this.benchmarkCounters) {
          this.benchmarkCounters.pageEvaluations += 1;
        }
        const offset = Math.max(0, Math.floor(action.offset ?? 0));
        const revision = state.domRevision;
        let selector = action.selector ?? action.target ?? (action.index !== undefined ? `e${action.index + 1}` : undefined);
        if (!selector && action.query) {
          try {
            const queryHandle = await frame.$(action.query);
            if (queryHandle) {
              selector = action.query;
            }
            await queryHandle?.dispose();
          } catch (error) {
            // A natural-language query is not a CSS selector; fall back to
            // deterministic page-text extraction rather than executing it.
            if (!isInvalidSelectorError(error) && !isMissingElementError(error)) {
              throw normalizeBrowserOperationError(error, signal);
            }
          }
        }
        const maxChars = Math.min(action.maxChars ?? 40_000, this.config.browser.maxHtmlChars);
        const resolvedSelector = selector ? await this.selectorFor(state, selector, action.frameId) : undefined;
        const includeLinks = action.includeLinks === true;
        const extracted = resolvedSelector
          ? await frame.$eval(resolvedSelector, (element, options: { start: number; limit: number; includeLinks: boolean }) => {
            const fullText = element.textContent ?? "";
            const value = fullText.slice(options.start, options.start + options.limit);
            const links = options.includeLinks
              ? [element, ...Array.from(element.querySelectorAll("a"))].slice(0, 100).map((candidate) => {
                const rawHref = (candidate as HTMLAnchorElement).href;
                try {
                  const url = new URL(rawHref);
                  if (url.protocol !== "http:" && url.protocol !== "https:") {
                    return undefined;
                  }
                  url.username = "";
                  url.password = "";
                  return { text: (candidate.textContent ?? "").trim().slice(0, 500), href: url.toString() };
                } catch {
                  return undefined;
                }
              }).filter((link): link is { text: string; href: string } => Boolean(link))
              : undefined;
            return { value, totalLength: fullText.length, truncated: options.start + value.length < fullText.length, links };
          }, { start: offset, limit: maxChars, includeLinks }).catch((error: unknown) => {
            if (isMissingElementError(error)) {
              throw new AppError("ELEMENT_NOT_FOUND", `No element matched '${resolvedSelector}'.`, { cause: error });
            }
            throw normalizeBrowserOperationError(error, signal);
          })
          : await frame.evaluate(({ start, limit, includeLinks }) => {
            const fullText = document.body?.innerText ?? "";
            const value = fullText.slice(start, start + limit);
            const links = includeLinks
              ? Array.from(document.querySelectorAll("a")).slice(0, 100).map((candidate) => {
                const rawHref = (candidate as HTMLAnchorElement).href;
                try {
                  const url = new URL(rawHref);
                  if (url.protocol !== "http:" && url.protocol !== "https:") {
                    return undefined;
                  }
                  url.username = "";
                  url.password = "";
                  return { text: (candidate.textContent ?? "").trim().slice(0, 500), href: url.toString() };
                } catch {
                  return undefined;
                }
              }).filter((link): link is { text: string; href: string } => Boolean(link))
              : undefined;
            return { value, totalLength: fullText.length, truncated: start + value.length < fullText.length, links };
          }, { start: offset, limit: maxChars, includeLinks });
        if (state.domRevision !== revision) {
          throw new AppError("STALE_PAGE_SLICE", "The page changed while its text slice was being collected. Retry with a fresh revision.", { retryable: true, details: { hint: "Capture browser_extract again and use its new revision." } });
        }
        const nextOffset = offset + extracted.value.length;
        return {
          offset,
          nextOffset,
          hasMore: extracted.truncated,
          revision,
          text: wrapUntrustedText("extracted_text", redactSecretPlaceholders(extracted.value), maxChars),
          truncated: extracted.truncated,
          textTruncated: extracted.truncated,
          ...(extracted.links ? {
            links: extracted.links.map((link) => ({
              text: wrapUntrustedText("extracted_link_text", redactSecretPlaceholders(link.text), 500),
              href: safeUrl(link.href),
              untrustedUrl: wrapUntrustedText("extracted_link_url", redactSecretPlaceholders(link.href), 4_096),
            })),
          } : {}),
        };
      }
      case "get_html": {
        const selector = action.selector ?? action.target ?? (action.index !== undefined ? `e${action.index + 1}` : undefined);
        const maxChars = Math.min(action.maxChars ?? this.config.browser.maxHtmlChars, this.config.browser.maxHtmlChars);
        const result = selector
          ? await frame.$eval(await this.selectorFor(state, selector, action.frameId), (element, limit) => {
            const clone = element.cloneNode(true) as Element;
            if (clone.tagName.toLowerCase() === "script") {
              clone.textContent = "";
            }
            for (const script of Array.from(clone.querySelectorAll("script"))) {
              script.remove();
            }
            for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
              if (node.tagName.toLowerCase() === "input") {
                node.removeAttribute("value");
              }
              if (node.tagName.toLowerCase() === "textarea") {
                node.textContent = "";
              }
              for (const attribute of Array.from(node.attributes)) {
                if (/^(?:value|srcdoc|autocomplete|on[a-z]+|data-)/i.test(attribute.name)) {
                  node.removeAttribute(attribute.name);
                }
              }
            }
            const html = clone.outerHTML;
            return { html: html.slice(0, limit + 1), truncated: html.length > limit };
          }, maxChars).catch((error: unknown) => {
            // Only a genuine miss may degrade to ELEMENT_NOT_FOUND below;
            // execution/timeout/cancellation failures must surface as-is.
            if (isMissingElementError(error)) {
              return undefined;
            }
            throw normalizeBrowserOperationError(error, signal);
          })
          : await frame.evaluate((limit) => {
            const clone = document.documentElement.cloneNode(true) as Element;
            for (const script of Array.from(clone.querySelectorAll("script"))) {
              script.remove();
            }
            for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
              if (node.tagName.toLowerCase() === "input") {
                node.removeAttribute("value");
              }
              if (node.tagName.toLowerCase() === "textarea") {
                node.textContent = "";
              }
              for (const attribute of Array.from(node.attributes)) {
                if (/^(?:value|srcdoc|autocomplete|on[a-z]+|data-)/i.test(attribute.name)) {
                  node.removeAttribute(attribute.name);
                }
              }
            }
            const html = clone.outerHTML;
            return { html: html.slice(0, limit + 1), truncated: html.length > limit };
          }, maxChars);
        if (!result?.html) {
          throw new AppError("ELEMENT_NOT_FOUND", selector ? `No element matched '${selector}'.` : "The page did not expose HTML.");
        }
        const html = result.html.slice(0, maxChars);
        return { html: wrapUntrustedText("page_html", redactSecretPlaceholders(html), maxChars), truncated: result.truncated, selector: selector ?? null };
      }
      case "upload_file": {
        throwIfAborted(signal);
        const selector = await this.selectorFor(state, targetForAction(action, "selector"), action.frameId);
        throwIfAborted(signal);
        const staged = await this.stageUploadFile(requireField(action.filePath, "filePath"), signal);
        throwIfAborted(signal);
        let input: ElementHandle<HTMLInputElement> | null;
        try {
          input = await frame.$(selector) as ElementHandle<HTMLInputElement> | null;
        } catch (error) {
          await unlinkIfPresent(staged.path);
          throw error;
        }
        if (!input) {
          await unlinkIfPresent(staged.path);
          throw new AppError("ELEMENT_NOT_FOUND", `No element matched '${selector}'.`);
        }
        try {
          await input.uploadFile(staged.path);
          throwIfAborted(signal);
          return { uploaded: wrapUntrustedText("uploaded_file_name", redactSecretPlaceholders(basename(staged.displayName)), 512), bytes: Math.min(staged.size, Number.MAX_SAFE_INTEGER) };
        } finally {
          await input.dispose().catch(() => undefined);
          await unlinkIfPresent(staged.path);
        }
      }
      case "screenshot": {
        const requestedMaxBytes = action.maxBytes ?? action.max_bytes ?? this.config.browser.maxScreenshotBytes;
        const format = action.format ?? "png";
        const screenshot = await this.screenshotBase64(page, action.fullPage ?? action.full_page ?? action.full ?? false, Math.min(requestedMaxBytes, this.config.browser.maxScreenshotBytes), format, action.quality, action.maxDimension ?? action.max_dim);
        return { pageId: state.id, url: safeUrl(page.url()), screenshotBase64: screenshot.screenshotBase64, screenshot: screenshot.metadata, mimeType: format === "jpeg" ? "image/jpeg" : "image/png", quality: format === "jpeg" ? action.quality ?? 80 : undefined };
      }
      case "save_as_pdf": {
        throwIfAborted(signal);
        const outputPath = await this.outputFilePath(requireField(action.outputPath ?? action.filePath, "outputPath"));
        throwIfAborted(signal);
        await rejectSymlink(outputPath);
        const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.tmp-${randomUUID()}`);
        try {
          throwIfAborted(signal);
          await page.pdf({ path: temporaryPath, printBackground: true, format: "A4" });
          throwIfAborted(signal);
          await rejectSymlink(outputPath);
          throwIfAborted(signal);
          await rename(temporaryPath, outputPath);
        } catch (error) {
          await unlinkIfPresent(temporaryPath);
          throw error;
        }
        return { saved: wrapUntrustedText("saved_file_path", redactSecretPlaceholders(await this.serverRelativePath(outputPath)), 1_024) };
      }
      case "list_downloads":
        return this.listDownloads();
      case "dropdown_options": {
        const selector = await this.selectorFor(state, targetForAction(action, "selector"), action.frameId);
        const options = await frame.$$eval(selector, (elements) => elements.flatMap((element) => Array.from((element as HTMLSelectElement).options ?? []).slice(0, 200).map((option) => ({ value: option.value, label: option.textContent?.trim() ?? "", selected: option.selected }))).slice(0, 200));
        return options.map((option) => ({
          value: wrapUntrustedText("option_value", redactSecretPlaceholders(option.value), 500),
          label: wrapUntrustedText("option_label", redactSecretPlaceholders(option.label), 500),
          selected: option.selected,
        }));
      }
      case "page_next": {
        if (this.benchmarkCounters) {
          this.benchmarkCounters.pageEvaluations += 1;
        }
        const offset = Math.max(0, Math.floor(action.offset ?? action.amount ?? 0));
        const revision = action.revision;
        const revisionAtStart = state.domRevision;
        if (revision !== undefined && revision !== revisionAtStart) {
          throw new AppError("STALE_PAGE_SLICE", "The requested page slice revision is stale. Extract the page again and retry.", { retryable: true, details: { expectedRevision: revisionAtStart, providedRevision: revision, hint: "Capture browser_extract again and use its new revision." } });
        }
        const maxChars = Math.min(action.maxChars ?? 40_000, this.config.browser.maxHtmlChars);
        const result = await frame.evaluate(({ start, limit }) => {
          const fullText = document.body?.innerText ?? "";
          const text = fullText.slice(start, start + limit);
          return { text, totalLength: fullText.length, hasMore: start + text.length < fullText.length };
        }, { start: offset, limit: maxChars });
        if (state.domRevision !== revisionAtStart) {
          throw new AppError("STALE_PAGE_SLICE", "The page changed while its text slice was being collected. Retry with a fresh revision.", { retryable: true, details: { hint: "Capture browser_extract again and use its new revision." } });
        }
        return { offset, nextOffset: offset + result.text.length, hasMore: result.hasMore, revision: revisionAtStart, text: wrapUntrustedText("page_text", redactSecretPlaceholders(result.text), maxChars) };
      }
      case "search_page": {
        if (this.benchmarkCounters) {
          this.benchmarkCounters.pageEvaluations += 1;
        }
        const query = requireField(action.query ?? action.text, "query");
        const matches = await frame.evaluate((needle) => {
          const text = document.body?.innerText ?? "";
          const lower = text.toLowerCase();
          const target = needle.toLowerCase();
          const output: string[] = [];
          let index = lower.indexOf(target);
          let totalMatches = 0;
          while (index >= 0 && output.length < 20) {
            output.push(text.slice(Math.max(0, index - 120), Math.min(text.length, index + needle.length + 120)));
            totalMatches += 1;
            index = lower.indexOf(target, index + target.length);
          }
          while (index >= 0) {
            totalMatches += 1;
            index = lower.indexOf(target, index + target.length);
          }
          return { matches: output, totalMatches };
        }, query);
        return { query, matches: matches.matches.map((match) => wrapUntrustedText("page_match", redactSecretPlaceholders(match), 500)), totalMatches: matches.totalMatches, matchesTruncated: matches.totalMatches > matches.matches.length };
      }
      case "find_elements": {
        const selector = targetForAction(action, "selector");
        const safeSelector = await this.selectorFor(state, selector, action.frameId);
        const elements = await frame.$$eval(safeSelector, (matches) => matches.slice(0, 50).map((element) => {
          const attributes: Record<string, string> = {};
          let omittedAttributes = 0;
          for (const attribute of Array.from(element.attributes).slice(0, 40)) {
            if (/^(?:value|srcdoc|autocomplete|on[a-z]+|data-)/i.test(attribute.name)) {
              omittedAttributes += 1;
              continue;
            }
            attributes[attribute.name] = attribute.value.slice(0, 200);
          }
          return { tag: element.tagName.toLowerCase(), text: (element.textContent ?? "").trim().slice(0, 300), attributes, omittedAttributes };
        }));
        return elements.map((element) => ({
          tag: element.tag,
          text: wrapUntrustedText("element_text", redactSecretPlaceholders(element.text), 300),
          attributes: Object.fromEntries(Object.entries(element.attributes).map(([name, value]) => [name, wrapUntrustedText("element_attribute", redactSecretPlaceholders(value), 500)])),
          omittedAttributes: element.omittedAttributes,
        }));
      }
      case "list_interactive": {
        if (state.snapshotId && state.snapshotInteractive) {
          return state.snapshotInteractive;
        }
        return (await this.snapshotUnlocked({ pageId: state.id, maxChars: 1_000, signal })).interactive;
      }
      case "list_frames":
        return this.listFrames(state);
      case "accessibility_snapshot":
        return this.accessibilitySnapshot(state, action.maxNodes ?? 500, action.maxChars ?? 40_000, action.interestingOnly ?? true);
      case "get_computed_style": {
        const selector = await this.selectorFor(state, targetForAction(action, "selector"), action.frameId);
        return frame.$eval(selector, (element) => {
          const style = getComputedStyle(element);
          return { display: style.display, visibility: style.visibility, position: style.position, color: style.color, backgroundColor: style.backgroundColor, width: style.width, height: style.height, zIndex: style.zIndex };
        });
      }
      case "get_page_info":
        return { pageId: state.id, url: safeUrl(page.url()), title: wrapUntrustedText("page_title", redactSecretPlaceholders((await page.title().catch(() => "")).slice(0, 1_000)), 1_000), viewport: page.viewport(), dimensions: await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY: window.scrollY })) };
      case "evaluate": {
        const code = requireField(action.code ?? action.expression, "code");
        const value = await frame.evaluate((source) => (0, eval)(source), code);
        return sanitizeEvaluateResult(value);
      }
      case "hover":
        await frame.hover(await this.selectorFor(state, targetForAction(action, "target"), action.frameId));
        return { hovered: true };
      case "press_and_hold": {
        const selector = await this.selectorFor(state, targetForAction(action, "target"), action.frameId);
        const targetHandle = await frame.$(selector);
        try {
          const bounds = await targetHandle?.boundingBox();
          if (!bounds) {
            throw new AppError("ELEMENT_NOT_FOUND", "The hold target is detached or not visible.");
          }
          const box = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          await page.mouse.move(box.x, box.y);
          const button = action.button ?? "left";
          await page.mouse.down({ button });
          try {
            await wait(action.durationMs ?? action.milliseconds ?? 2_000, signal);
          } finally {
            await page.mouse.up({ button }).catch(() => undefined);
          }
          return { heldMs: action.durationMs ?? action.milliseconds ?? 2_000 };
        } finally {
          await targetHandle?.dispose().catch(() => undefined);
        }
      }
      case "alert_get_text":
      case "alert_accept":
      case "alert_dismiss":
      case "alert_send_keys":
        return this.executeDialogAction(state, action, signal);
      case "detect_challenge":
        return this.detectChallenge(state, signal);
      case "wait_for_human":
        return this.waitForHuman(state, action.timeoutMs ?? 120_000, action.pollMs ?? 1_000, signal);
      case "get_cookies": {
        const cookies = await page.cookies();
        return cookies.slice(0, 200).map((cookie) => ({
          name: wrapUntrustedText("cookie_name", redactSecretPlaceholders(cookie.name), 256),
          domain: wrapUntrustedText("cookie_domain", redactSecretPlaceholders(cookie.domain), 512),
          path: wrapUntrustedText("cookie_path", redactSecretPlaceholders(cookie.path), 2_000),
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expires: cookie.expires,
          session: cookie.session,
        }));
      }
      case "set_cookie": {
        const cookieName = requireField(action.cookieName, "cookieName");
        const url = await this.policy.assertNavigationAllowedAsync(action.url ?? page.url());
        if (action.cookieDomain) {
          await this.policy.assertNavigationAllowedAsync(`https://${action.cookieDomain.replace(/^\.+/, "")}`);
        }
        await page.setCookie({ name: cookieName, value: action.cookieValue ?? action.value ?? "", url: url.toString(), domain: action.cookieDomain, path: action.cookiePath ?? "/", secure: action.cookieSecure, httpOnly: action.cookieHttpOnly });
        return { set: wrapUntrustedText("cookie_name", redactSecretPlaceholders(cookieName), 256) };
      }
      case "delete_cookies": {
        const cookieName = requireField(action.cookieName, "cookieName");
        if (action.cookieDomain) {
          await this.policy.assertNavigationAllowedAsync(`https://${action.cookieDomain.replace(/^\.+/, "")}`);
        }
        await page.deleteCookie({ name: cookieName, domain: action.cookieDomain, path: action.cookiePath ?? "/" });
        return { deleted: wrapUntrustedText("cookie_name", redactSecretPlaceholders(cookieName), 256) };
      }
      case "get_storage": {
        const area = action.storageArea ?? "local";
        const key = action.storageKey;
        const maxValueChars = Math.min(action.maxChars ?? 20_000, 50_000);
        const result = await page.evaluate(({ areaName, storageKey, valueLimit, includeValues }) => {
          const storage = areaName === "session" ? window.sessionStorage : window.localStorage;
          if (storageKey) {
            const value = storage.getItem(storageKey);
            return { area: areaName, key: storageKey, value: value?.slice(0, valueLimit) ?? null, truncated: Boolean(value && value.length > valueLimit) };
          }
          const rawKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((entryKey): entryKey is string => Boolean(entryKey)).slice(0, 200);
          const keys = rawKeys.map((entryKey) => entryKey.slice(0, 1_000));
          if (!includeValues) {
            return { area: areaName, keys, valueCount: storage.length, valuesOmitted: true };
          }
          const values: Record<string, string> = {};
          let truncated = storage.length > 200;
          for (const entryKey of rawKeys) {
            const entryValue = storage.getItem(entryKey) ?? "";
            values[entryKey.slice(0, 1_000)] = entryValue.slice(0, valueLimit);
            truncated ||= entryValue.length > valueLimit || entryKey.length > 1_000;
          }
          return { area: areaName, values, truncated };
        }, { areaName: area, storageKey: key, valueLimit: maxValueChars, includeValues: action.includeValues === true });
        return sanitizeStorageResult(result);
      }
      case "set_storage": {
        const area = action.storageArea ?? "local";
        const key = requireField(action.storageKey, "storageKey");
        const value = action.storageValue ?? action.value ?? "";
        await page.evaluate(({ areaName, storageKey, storageValue }) => {
          const storage = areaName === "session" ? window.sessionStorage : window.localStorage;
          storage.setItem(storageKey, storageValue);
        }, { areaName: area, storageKey: key, storageValue: value });
        return { set: true, area, key: wrapUntrustedText("storage_key", redactSecretPlaceholders(key), 1_000) };
      }
      case "clear_storage": {
        const area = action.storageArea ?? "local";
        if (!action.storageKey && action.storageAll !== true) {
          throw new AppError("INVALID_ACTION", "Clearing storage requires storageKey or storageAll=true.");
        }
        if (action.storageKey) {
          await page.evaluate(({ areaName, storageKey }) => {
            const storage = areaName === "session" ? window.sessionStorage : window.localStorage;
            storage.removeItem(storageKey);
          }, { areaName: area, storageKey: action.storageKey });
          return { cleared: true, area, key: wrapUntrustedText("storage_key", redactSecretPlaceholders(action.storageKey), 1_000) };
        }
        await page.evaluate((areaName) => {
          const storage = areaName === "session" ? window.sessionStorage : window.localStorage;
          storage.clear();
        }, area);
        return { cleared: true, area, all: true };
      }
      case "close_browser":
        return this.closeBrowser();
    }
  }

  private async closeTabAction(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    if (action.pageId && action.target) {
      throw new AppError("INVALID_ACTION", "close_tab accepts exactly one of pageId or target.");
    }
    if (action.ref || action.selector !== undefined || action.index !== undefined || action.frameId || action.snapshotId) {
      throw new AppError("INVALID_ACTION", "close_tab targets a tab pageId, not an element ref, selector, index, frame, or snapshot.");
    }
    const target = action.pageId ?? action.target;
    if (!target) {
      throw new AppError("INVALID_ACTION", "close_tab requires pageId or target.");
    }
    if (isElementReference(target)) {
      throw new AppError("INVALID_ACTION", "close_tab target must be a tab pageId or tab identifier, not an element ref.");
    }
    const state = await this.pageState(target, signal);
    await this.assertCurrentPageAllowed(state.page);
    throwIfAborted(signal);
    const wasCurrent = this.currentPageId === state.id;
    await state.page.close();
    this.retireState(state);
    if (wasCurrent) {
      const remaining = this.browser ? (await this.browser.pages()).filter((candidate) => !isPageClosed(candidate)) : [];
      const fallback = remaining[0];
      this.currentPageId = fallback ? this.stateFor(fallback).id : undefined;
    }
    return { closed: state.id };
  }

  private async executeScript(rawScript: string, signal?: AbortSignal, confirmDestructive = false): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawScript);
    } catch (error) {
      throw new AppError("SCRIPT_INVALID", "run_script currently accepts a JSON array of browser actions.", { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ACTION_PLAN_STEPS) {
      throw new AppError("SCRIPT_INVALID", `The script must be a non-empty JSON array of at most ${MAX_ACTION_PLAN_STEPS} actions.`);
    }
    const validation = BrowserActionPlanSchema.safeParse(parsed);
    if (!validation.success) {
      throw new AppError("SCRIPT_INVALID", "A batch item is not a valid browser action.", {
        details: { issues: validation.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      });
    }
    return this.executeBatchUnlocked(validation.data, { confirmDestructive }, signal);
  }

  private async executeBatchUnlocked(actions: BrowserAction[], options: { confirmDestructive?: boolean; includeSnapshot?: boolean }, signal?: AbortSignal): Promise<unknown> {
    const results: unknown[] = [];
    for (const [index, candidate] of actions.entries()) {
      const action = candidate;
      if (action.action === "run_script") {
        throw new AppError("SCRIPT_INVALID", "Nested run_script actions are not allowed.");
      }
      if (action.action === "close_browser" && index !== actions.length - 1) {
        throw new AppError("SCRIPT_INVALID", "close_browser must be the final action in a batch.", {
          details: batchFailureDetails(index, action.action, results),
        });
      }
      if (action.action === "screenshot") {
        throw new AppError("SCRIPT_INVALID", "Screenshots must be requested with browser_screenshot so the image is returned as MCP image content.");
      }
      if (!options.confirmDestructive && isDestructiveBatchAction(action.action)) {
        throw new AppError("DESTRUCTIVE_CONFIRMATION_REQUIRED", `Action '${action.action}' must be executed separately or with confirmDestructive=true.`, { retryable: true, details: { hint: "Set confirmDestructive=true or run the action separately.", ...batchFailureDetails(index, action.action, results) } });
      }
      try {
        // A batch owns one trailing snapshot. Suppress per-action snapshots so
        // the result remains ordered and bounded even when every action opts in.
        const result = await this.executeUnlocked({ ...action, includeSnapshot: false }, signal);
        if (DOM_MUTATING_ACTIONS.has(action.action)) {
          this.invalidateActionSnapshot(action, result);
        }
        results.push(result);
      } catch (error) {
        const normalized = asAppError(normalizeBrowserOperationError(error, signal));
        throw new AppError(normalized.code, normalized.message, {
          retryable: normalized.retryable,
          details: { ...normalized.details, ...batchFailureDetails(index, action.action, results) },
          cause: error,
        });
      }
    }
    const output: Record<string, unknown> = { results };
    if (options.includeSnapshot) {
      try {
        output.snapshot = await this.snapshotUnlocked({ pageId: this.currentPageId, maxChars: 8_000, signal });
      } catch (error) {
        output.snapshot = null;
        output.snapshotError = boundedSnapshotError(error);
      }
    }
    return output;
  }

  private async ensureBrowser(signal?: AbortSignal): Promise<Browser> {
    if (this.shuttingDown) {
      throw new AppError("SERVER_CLOSING", "The browser runtime is shutting down.", { retryable: true });
    }
    if (this.config.browser.mode === "disabled") {
      throw new AppError("BROWSER_DISABLED", "Browser control is disabled by configuration.");
    }
    if (this.recoveryRequired) {
      throw new AppError("BROWSER_RECOVERY_REQUIRED", "Browser recovery is required before browser work can continue. Call browser_close_session and retry.", { retryable: true, details: { hint: "Call browser_close_session and retry after cleanup succeeds." } });
    }
    throwIfAborted(signal);
    if (this.browserClosePromise) {
      await awaitWithAbort(this.browserClosePromise, signal);
      throwIfAborted(signal);
      return this.ensureBrowser(signal);
    }
    if (this.connectionSettlementPromise) {
      const settling = this.connectionSettlementPromise;
      await awaitWithAbort(settling, signal);
      if (this.connectionSettlementPromise === settling) {
        this.connectionSettlementPromise = undefined;
      }
      throwIfAborted(signal);
      return this.ensureBrowser(signal);
    }
    const generation = this.lifecycleGeneration;
    if (this.browser) {
      return this.browser;
    }
    if (this.connectionPromise) {
      const pendingConnection = this.connectionPromise;
      const browser = await awaitWithAbort(pendingConnection, signal);
      if (!this.isCurrentBrowser(browser, generation)) {
        throw this.browserLifecycleError();
      }
      return browser;
    }
    const connection = this.connectBrowser(generation);
    this.connectionPromise = connection;
    // Keep the shared connection promise alive when the initiating request is
    // cancelled. Other callers must await the same connection instead of
    // racing a second launch/connect attempt.
    void connection.then(
      () => {
        if (this.connectionPromise === connection) {
          this.connectionPromise = undefined;
        }
      },
      () => {
        if (this.connectionPromise === connection) {
          this.connectionPromise = undefined;
        }
      },
    );
    const browser = await awaitWithAbort(connection, signal);
    if (!this.isCurrentBrowser(browser, generation)) {
      throw this.browserLifecycleError();
    }
    return browser;
  }

  private async connectBrowser(generation: number): Promise<Browser> {
    if (this.connectionSettlementPromise) {
      const settling = this.connectionSettlementPromise;
      await settling;
      if (this.connectionSettlementPromise === settling) {
        this.connectionSettlementPromise = undefined;
      }
      if (this.shuttingDown) {
        throw new AppError("SERVER_CLOSING", "The browser runtime is shutting down.", { retryable: true });
      }
    }
    let browser: Browser | undefined;
    let ownsBrowser = false;
    let connection: Promise<Browser> | undefined;
    try {
      if (this.config.browser.mode === "managed") {
        const endpoint = await this.probeManagedEndpoint();
        ownsBrowser = true;
        if (endpoint.state === "live" && endpoint.browserURL) {
          connection = this.connect({ browserURL: endpoint.browserURL, protocolTimeout: this.config.browser.cdpTimeoutMs });
        } else {
          const executablePath = this.config.browser.executablePath ?? findChromeExecutable()?.path;
          if (!executablePath) {
            throw new AppError("BROWSER_NOT_CONFIGURED", `Managed browser mode could not find Chrome. Checked: ${chromeExecutableSearchPaths().join(", ")}. Install Chrome or set SMOOTH_OPERATOR_BROWSER_EXECUTABLE.`);
          }
          connection = this.launch({
            headless: this.config.browser.headless,
            executablePath,
            userDataDir: this.config.browser.userDataDir,
            args: nativeBrowserLaunchArgs(),
            timeout: this.config.browser.connectTimeoutMs,
            protocolTimeout: this.config.browser.cdpTimeoutMs,
          });
        }
      } else if (this.config.browser.mode === "launch" || (this.config.browser.autoLaunch && this.config.browser.executablePath)) {
        if (!this.config.browser.executablePath) {
          throw new AppError("BROWSER_NOT_CONFIGURED", "Launch mode requires SMOOTH_OPERATOR_BROWSER_EXECUTABLE.");
        }
        ownsBrowser = true;
        connection = this.launch({
          headless: this.config.browser.headless,
          executablePath: this.config.browser.executablePath,
          userDataDir: this.config.browser.userDataDir,
          args: nativeBrowserLaunchArgs(),
          timeout: this.config.browser.connectTimeoutMs,
          protocolTimeout: this.config.browser.cdpTimeoutMs,
        });
      } else if (this.config.browser.wsEndpoint) {
        connection = this.connect({ browserWSEndpoint: this.config.browser.wsEndpoint, protocolTimeout: this.config.browser.cdpTimeoutMs });
      } else if (this.config.browser.url) {
        connection = this.connect({ browserURL: this.config.browser.url, protocolTimeout: this.config.browser.cdpTimeoutMs });
      } else {
        throw new AppError("BROWSER_NOT_CONFIGURED", "Configure a Chrome DevTools endpoint or launch executable.");
      }
      browser = await awaitBrowserConnection(connection, this.config.browser.connectTimeoutMs);
      if (this.shuttingDown || generation !== this.lifecycleGeneration || this.shutdownController.signal.aborted) {
        const lateBrowser = browser;
        browser = undefined;
        await closeConnectedBrowser(lateBrowser, ownsBrowser, this.logger);
        throw new AppError("SERVER_CLOSING", "The browser runtime is shutting down.", { retryable: true });
      }
      this.browser = browser;
      this.ownsBrowser = ownsBrowser;
      const connectedBrowser = browser;
      browser.on("disconnected", () => {
        if (this.browser !== connectedBrowser) {
          return;
        }
        this.logger.warn("Browser disconnected");
        this.detachTargetGuard();
        this.browser = undefined;
        this.ownsBrowser = false;
        this.lifecycleGeneration += 1;
        this.retireAllStates();
      });
      this.installTargetGuard(browser);
      browser.on("targetcreated", (target) => {
        void this.prepareTarget(target);
      });
      return browser;
    } catch (error) {
      if (connection && isBrowserConnectTimeout(error)) {
        this.trackLateConnection(connection, ownsBrowser);
      }
      if (browser && this.browser !== browser) {
        await closeConnectedBrowser(browser, ownsBrowser, this.logger);
      }
      if (this.browser === browser) {
        this.browser = undefined;
        this.ownsBrowser = false;
        this.retireAllStates();
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("BROWSER_CONNECT_FAILED", "The MCP server could not connect to the browser.", { retryable: true, cause: error });
    }
  }

  private trackLateConnection(connection: Promise<Browser>, ownsBrowser: boolean): void {
    if (this.connectionSettlementPromise) {
      return;
    }
    const settling = connection.then(
      (lateBrowser) => closeConnectedBrowser(lateBrowser, ownsBrowser, this.logger),
      () => undefined,
    ).then(() => undefined);
    this.connectionSettlementPromise = settling;
    void settling.then(() => {
      if (this.connectionSettlementPromise === settling) {
        this.connectionSettlementPromise = undefined;
      }
    }, () => {
      if (this.connectionSettlementPromise === settling) {
        this.connectionSettlementPromise = undefined;
      }
    });
  }

  private async launch(options: PuppeteerLaunchOptions): Promise<Browser> {
    if (this.dependencies.launch) {
      return this.dependencies.launch(options);
    }
    return (await loadPuppeteer()).launch(options);
  }

  private async connect(options: PuppeteerConnectOptions): Promise<Browser> {
    if (this.dependencies.connect) {
      return this.dependencies.connect(options);
    }
    return (await loadPuppeteer()).connect(options);
  }

  private async probeManagedEndpoint(): Promise<ManagedEndpointProbe> {
    const userDataDir = this.config.browser.userDataDir;
    if (!userDataDir) {
      return { state: "no-file" };
    }
    const activePortPath = join(userDataDir, "DevToolsActivePort");
    let raw: string;
    try {
      const info = await lstat(activePortPath);
      if (!info.isFile() || info.size > 4_096) {
        this.logger.debug("Managed browser DevTools endpoint file is invalid", { path: activePortPath });
        return { state: "stale-probe-failed" };
      }
      raw = await readFile(activePortPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { state: "no-file" };
      }
      this.logger.debug("Managed browser DevTools endpoint file could not be read", { path: activePortPath, error: String(error) });
      return { state: "stale-probe-failed" };
    }
    const browserURL = parseDevToolsActivePort(raw);
    if (!browserURL) {
      this.logger.debug("Managed browser DevTools endpoint file is malformed", { path: activePortPath });
      return { state: "stale-probe-failed" };
    }
    try {
      const version = await (this.dependencies.probeEndpoint ?? probeDevToolsEndpoint)(browserURL, 2_000);
      return { state: "live", browserURL, version };
    } catch (error) {
      this.logger.debug("Managed browser DevTools endpoint probe failed", { browserURL, error: String(error) });
      return { state: "stale-probe-failed" };
    }
  }

  private async pageState(pageId?: string, signal?: AbortSignal): Promise<PageState> {
    if (this.benchmarkCounters) {
      this.benchmarkCounters.pageLookups += 1;
    }
    const generation = this.lifecycleGeneration;
    throwIfAborted(signal);
    const browser = await this.ensureBrowser(signal);
    throwIfAborted(signal);
    const requestedId = pageId ? this.resolvePageId(pageId) : this.currentPageId;
    const tracked = requestedId ? this.states.get(requestedId) : undefined;
    if (tracked && tracked.lifecycleGeneration === generation && !tracked.disposed && !isPageClosed(tracked.page)) {
      try {
        await this.configurePage(tracked, signal);
        this.assertStateLive(tracked);
        return tracked;
      } catch (error) {
        await this.disposeStalePageState(tracked);
        throw error;
      }
    }
    let pages: Page[];
    try {
      if (this.benchmarkCounters) {
        this.benchmarkCounters.pageEnumerations += 1;
      }
      pages = await browser.pages();
    } catch (error) {
      if (!this.isCurrentBrowser(browser, generation)) {
        throw this.browserLifecycleError();
      }
      throw normalizeBrowserOperationError(error, signal);
    }
    throwIfAborted(signal);
    if (!this.isCurrentBrowser(browser, generation)) {
      throw this.browserLifecycleError();
    }
    if (pages.length === 0) {
      let page: Page;
      try {
        page = await browser.newPage();
      } catch (error) {
        if (!this.isCurrentBrowser(browser, generation)) {
          throw this.browserLifecycleError();
        }
        throw normalizeBrowserOperationError(error, signal);
      }
      if (!this.isCurrentBrowser(browser, generation)) {
        await closePageSafely(page);
        throw this.browserLifecycleError();
      }
      let state: PageState | undefined;
      try {
        throwIfAborted(signal);
        state = this.stateFor(page);
        await this.configurePage(state, signal);
        await this.releaseTargetGuardForPage(page);
        this.assertStateLive(state);
        return state;
      } catch (error) {
        if (state) {
          await this.disposePageState(state);
        } else {
          await closePageSafely(page);
        }
        throw error;
      }
    }
    if (pageId) {
      const resolvedPageId = this.resolvePageId(pageId);
      const existing = resolvedPageId ? this.states.get(resolvedPageId) : undefined;
      if (existing && pages.includes(existing.page) && !isPageClosed(existing.page)) {
        try {
          await this.configurePage(existing, signal);
          this.assertStateLive(existing);
          return existing;
        } catch (error) {
          await this.disposeStalePageState(existing);
          throw error;
        }
      }
      if (existing) {
        this.retireState(existing);
      }
      const matching = resolvedPageId === undefined
        ? undefined
        : pages.find((page) => this.ids.get(page) === resolvedPageId && !isPageClosed(page));
      if (!matching) {
        throw new AppError("TAB_NOT_FOUND", `Tab '${pageId}' was not found.`);
      }
      const state = this.stateFor(matching);
      try {
        await this.configurePage(state, signal);
        this.assertStateLive(state);
        return state;
      } catch (error) {
        await this.disposeStalePageState(state);
        throw error;
      }
    }
    const current = this.currentPageId ? this.states.get(this.currentPageId) : undefined;
    if (current && pages.includes(current.page) && !isPageClosed(current.page)) {
      try {
        await this.configurePage(current, signal);
        this.assertStateLive(current);
        return current;
      } catch (error) {
        await this.disposeStalePageState(current);
        throw error;
      }
    }
    if (current) {
      this.retireState(current);
    }
    const firstPage = pages.find((page) => !isPageClosed(page));
    if (!firstPage) {
      throw new AppError("BROWSER_CONNECT_FAILED", "The browser page is no longer available.", { retryable: true });
    }
    const state = this.stateFor(firstPage);
    try {
      await this.configurePage(state, signal);
      this.assertStateLive(state);
      this.currentPageId = state.id;
      return state;
    } catch (error) {
      await this.disposeStalePageState(state);
      throw error;
    }
  }

  private resolvePageId(pageId: string): string | undefined {
    if (this.states.has(pageId)) {
      return pageId;
    }
    const matches = [...this.states.values()].filter((state) => state.id.endsWith(pageId));
    if (matches.length > 1) {
      throw new AppError("TAB_ID_AMBIGUOUS", `Tab identifier '${pageId}' matches multiple tabs. Use the full pageId.`, { retryable: true, details: { matches: matches.map((state) => state.id) } });
    }
    return matches[0]?.id;
  }

  /** Install a Fetch guard at the CDP boundary to policy-check new targets while paused. */
  private installTargetGuard(browser: Browser): void {
    if (this.targetGuardConnection) {
      return;
    }
    const connection = (browser as unknown as { _connection?: unknown })._connection;
    if (!connection || typeof (connection as { on?: unknown }).on !== "function") {
      this.targetGuardUnavailable = true;
      this.logger.warn("Browser target guard is unavailable; popup actions will be blocked");
      return;
    }
    this.targetGuardUnavailable = false;
    const targetConnection = connection as TargetGuardConnection;
    if (typeof targetConnection.isAutoAttached !== "function") {
      this.targetGuardUnavailable = true;
      this.logger.warn("Browser target guard is unavailable; attachment ownership cannot be determined");
      return;
    }
    // Puppeteer 25 emits `sessionattached` for both auto-attached targets and
    // sessions created by page.createCDPSession().  parentSession() is not a
    // discriminator: for a top-level auto-attached target it intentionally
    // returns the session itself.  Keep the session event only as a lookup
    // table, then use the raw Target.attachedToTarget payload (which includes
    // targetInfo and sessionId) plus Connection.isAutoAttached() below.
    const sessionListener = (value: unknown): void => {
      if (!isCdpSessionLike(value)) {
        return;
      }
      this.pendingTargetGuardSessions.set(value.id(), value);
    };
    const rawListener = (value: unknown): void => {
      const event = parseTargetAttachedEvent(value);
      if (!event) {
        return;
      }
      const session = this.pendingTargetGuardSessions.get(event.sessionId)
        ?? getCdpSession(targetConnection, event.sessionId);
      this.pendingTargetGuardSessions.delete(event.sessionId);
      this.pendingTargetGuardInfos.delete(event.sessionId);
      if (!isGuardableTarget(event.targetInfo)) {
        return;
      }
      const autoAttached = isAutoAttachedTarget(targetConnection, event.targetInfo.targetId);
      if (autoAttached !== true) {
        // A false result is a manually created session and must never inherit
        // the target guard.  An unknown result means this Puppeteer/CDP build
        // does not expose the discrimination needed for a safe guard; fail
        // closed for that target instead of silently allowing its first
        // request through.
        if (autoAttached === undefined && event.sessionId) {
          this.unguardedTargetSessions.add(event.sessionId);
          if (targetConnection.send) {
            void targetConnection.send("Target.closeTarget", { targetId: event.targetInfo.targetId }).catch(() => undefined);
          }
          void sendSessionCommand(session, "Page.close").catch(() => undefined);
          this.logger.warn("New browser target guard could not determine attachment ownership");
        }
        return;
      }
      if (!session) {
        this.unguardedTargetSessions.add(event.sessionId);
        if (targetConnection.send) {
          void targetConnection.send("Target.closeTarget", { targetId: event.targetInfo.targetId }).catch(() => undefined);
        }
        this.logger.warn("New browser target guard could not find its CDP session");
        return;
      }
      void this.guardTargetSession(session, event.targetInfo).catch((error: unknown) => {
        this.logger.warn("New browser target guard failed", { error: String(error) });
      });
    };
    const detachedListener = (value: unknown): void => {
      if (!isRecordValue(value) || typeof value.sessionId !== "string") {
        return;
      }
      const guard = this.targetGuardSessions.get(value.sessionId);
      if (guard) {
        guard.released = true;
        removeCdpListener(guard.session, "Fetch.requestPaused", guard.requestPausedListener);
        removeCdpListener(guard.session, "disconnected", guard.disconnectedListener);
        this.targetGuardSessions.delete(value.sessionId);
      }
      this.pendingTargetGuardSessions.delete(value.sessionId);
      this.pendingTargetGuardInfos.delete(value.sessionId);
    };
    targetConnection.on("sessionattached", sessionListener);
    targetConnection.on("Target.attachedToTarget", rawListener);
    targetConnection.on("Target.detachedFromTarget", detachedListener);
    // Connection.emit dispatches Puppeteer's TargetManager listeners in
    // registration order.  Wrapping it lets us issue Fetch.enable before
    // Puppeteer sends Runtime.runIfWaitingForDebugger for the same target;
    // the regular raw event subscription remains as a compatibility fallback
    // for alternate connection implementations.
    const originalEmit = targetConnection.emit;
    if (originalEmit) {
      const wrappedEmit = (event: string, value: unknown): boolean => {
        if (event === "Target.attachedToTarget") {
          rawListener(value);
        }
        return originalEmit.call(targetConnection, event, value);
      };
      try {
        targetConnection.emit = wrappedEmit;
        this.targetGuardOriginalEmit = originalEmit;
        this.targetGuardWrappedEmit = wrappedEmit;
      } catch {
        this.targetGuardOriginalEmit = undefined;
        this.targetGuardWrappedEmit = undefined;
      }
    }
    this.targetGuardConnection = targetConnection;
    this.targetGuardConnectionListener = sessionListener;
    this.targetGuardRawConnectionListener = rawListener;
    this.targetGuardDetachedListener = detachedListener;
    if (targetConnection.send) {
      void targetConnection.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch((error: unknown) => {
        this.targetGuardUnavailable = true;
        this.logger.warn("Browser target auto-attachment could not be enabled", { error: String(error) });
      });
    }
  }

  private detachTargetGuard(): void {
    const connection = this.targetGuardConnection;
    const listener = this.targetGuardConnectionListener;
    const rawListener = this.targetGuardRawConnectionListener;
    const detachedListener = this.targetGuardDetachedListener;
    if (connection && listener && connection.off) {
      try {
        connection.off("sessionattached", listener);
        if (rawListener) {
          connection.off("Target.attachedToTarget", rawListener);
        }
        if (detachedListener) {
          connection.off("Target.detachedFromTarget", detachedListener);
        }
      } catch {
        // A disconnected CDP connection may reject listener access.
      }
    }
    if (connection && this.targetGuardOriginalEmit && this.targetGuardWrappedEmit && connection.emit === this.targetGuardWrappedEmit) {
      try {
        connection.emit = this.targetGuardOriginalEmit;
      } catch {
        // A frozen connection object can retain the wrapper until it closes.
      }
    }
    this.targetGuardConnection = undefined;
    this.targetGuardConnectionListener = undefined;
    this.targetGuardRawConnectionListener = undefined;
    this.targetGuardDetachedListener = undefined;
    this.targetGuardOriginalEmit = undefined;
    this.targetGuardWrappedEmit = undefined;
    this.targetGuardUnavailable = false;
    this.pendingTargetGuardSessions.clear();
    this.pendingTargetGuardInfos.clear();
    for (const guard of this.targetGuardSessions.values()) {
      guard.released = true;
      removeCdpListener(guard.session, "Fetch.requestPaused", guard.requestPausedListener);
      removeCdpListener(guard.session, "disconnected", guard.disconnectedListener);
      restoreGuardSend(guard);
      void guard.session.send("Fetch.disable").catch(() => undefined);
    }
    this.targetGuardSessions.clear();
    this.unguardedTargetSessions.clear();
  }

  private async guardTargetSession(session: CDPSession, targetInfo?: TargetAttachedEvent["targetInfo"]): Promise<void> {
    const sessionId = session.id();
    if (this.targetGuardSessions.has(sessionId) || this.shuttingDown) {
      return;
    }
    const guard: TargetGuardSession = {
      session,
      targetId: targetInfo?.targetId ?? sessionId,
      targetType: targetInfo?.type ?? "page",
      requestPausedListener: () => undefined,
      disconnectedListener: () => undefined,
      enabled: false,
      released: false,
      requestIds: new Set(),
      pendingRequests: new Set(),
    };
    guard.requestPausedListener = (event: unknown): void => {
      const pending = this.handleTargetGuardRequest(guard, event).catch((error: unknown) => {
        this.logger.debug("New target request guard callback failed", { error: String(error) });
      });
      guard.pendingRequests.add(pending);
      void pending.finally(() => guard.pendingRequests.delete(pending)).catch(() => undefined);
    };
    guard.disconnectedListener = (): void => {
      removeCdpListener(session, "Fetch.requestPaused", guard.requestPausedListener);
      removeCdpListener(session, "disconnected", guard.disconnectedListener);
      restoreGuardSend(guard);
      this.targetGuardSessions.delete(sessionId);
      this.unguardedTargetSessions.delete(sessionId);
    };
    this.targetGuardSessions.set(sessionId, guard);
    addCdpListener(session, "Fetch.requestPaused", guard.requestPausedListener);
    addCdpListener(session, "disconnected", guard.disconnectedListener);
    const sessionWithSend = session as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    const originalSend = sessionWithSend.send.bind(sessionWithSend);
    const countedSend = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (this.benchmarkCounters) {
        this.benchmarkCounters.cdpCommands += 1;
      }
      return originalSend(method, params);
    };
    let releaseDebugger!: () => void;
    let rejectDebugger!: (error: unknown) => void;
    const debuggerReady = new Promise<void>((resolve, reject) => {
      releaseDebugger = resolve;
      rejectDebugger = reject;
    });
    void debuggerReady.catch(() => undefined);
    const wrappedSend = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Runtime.runIfWaitingForDebugger") {
        await debuggerReady;
      }
      return countedSend(method, params);
    };
    guard.originalSend = originalSend;
    guard.wrappedSend = wrappedSend;
    try {
      if (this.targetGuardConnection?.send) {
        sessionWithSend.send = wrappedSend;
      } else {
        releaseDebugger();
      }
    } catch {
      // Some CDP session implementations expose a frozen send method. The
      // target remains guarded, but the connection-level auto-attach support
      // is treated as unavailable if Puppeteer cannot be gated safely.
      this.logger.warn("Browser target debugger resume could not be gated");
    }
    try {
      // Request-stage Fetch interception applies before page scripts and
      // therefore before a popup can issue a redirect/fetch to a private host.
      await countedSend("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      guard.enabled = true;
      releaseDebugger();
    } catch (error) {
      rejectDebugger(error);
      guard.released = true;
      removeCdpListener(session, "Fetch.requestPaused", guard.requestPausedListener);
      removeCdpListener(session, "disconnected", guard.disconnectedListener);
      restoreGuardSend(guard);
      this.targetGuardSessions.delete(sessionId);
      this.unguardedTargetSessions.add(sessionId);
      await this.closeGuardedTarget(guard);
      this.logger.warn("New browser target could not be guarded", { error: String(error) });
      throw error;
    }
  }

  private async closeGuardedTarget(guard: TargetGuardSession): Promise<void> {
    const connection = this.targetGuardConnection;
    if (connection?.send) {
      await connection.send("Target.closeTarget", { targetId: guard.targetId }).catch(() => undefined);
    }
    await guard.session.send("Page.close").catch(() => undefined);
  }

  private async handleTargetGuardRequest(guard: TargetGuardSession, event: unknown): Promise<void> {
    if (guard.released || !guard.enabled || !isRecordValue(event)) {
      return;
    }
    const requestId = typeof event.requestId === "string" ? event.requestId : "";
    const request = isRecordValue(event.request) ? event.request : undefined;
    const requestUrl = typeof request?.url === "string" ? request.url : "";
    if (!requestId || guard.requestIds.has(requestId)) {
      return;
    }
    if (guard.requestIds.size >= TARGET_GUARD_MAX_REQUEST_IDS) {
      // Keep the guard bounded if a target floods paused requests while its
      // page object is still being initialized.
      guard.requestIds.clear();
    }
    guard.requestIds.add(requestId);
    let allowed = false;
    try {
      if (/^about:blank(?:#.*)?$/i.test(requestUrl)) {
        allowed = true;
      } else if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
        allowed = guard.targetType === "service_worker" || guard.targetType === "shared_worker";
      } else if (/^wss?:\/\//i.test(requestUrl)) {
        await this.policy.assertNavigationAllowedAsync(requestUrl.replace(/^ws/i, "http"));
        allowed = true;
      } else if (/^https?:\/\//i.test(requestUrl)) {
        await this.policy.assertNavigationAllowedAsync(requestUrl);
        allowed = true;
      } else if (requestUrl) {
        allowed = false;
      }
    } catch (error) {
      this.logger.warn("New browser target request blocked", { url: safeUrl(requestUrl), code: error instanceof AppError ? error.code : "URL_BLOCKED" });
    }
    try {
      if (allowed) {
        await guard.session.send("Fetch.continueRequest", { requestId });
      } else {
        await guard.session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
    } catch (error) {
      this.logger.debug("New target request could not be resolved", { error: String(error) });
    } finally {
      guard.requestIds.delete(requestId);
    }
  }

  private targetGuardForPage(page: Page): TargetGuardSession | undefined {
    let sessionId: string | undefined;
    try {
      const target = page.target() as unknown as { _session?: () => CDPSession | undefined };
      sessionId = target._session?.()?.id();
    } catch {
      sessionId = undefined;
    }
    if (!sessionId) {
      return undefined;
    }
    return this.targetGuardSessions.get(sessionId);
  }

  private async waitForTargetGuardDrain(page: Page, signal?: AbortSignal): Promise<void> {
    const guard = this.targetGuardForPage(page);
    if (guard?.pendingRequests.size) {
      await awaitWithAbort(Promise.allSettled([...guard.pendingRequests]).then(() => undefined), signal);
    }
  }

  private async releaseTargetGuardForPage(page: Page): Promise<void> {
    let sessionId: string | undefined;
    try {
      const target = page.target() as unknown as { _session?: () => CDPSession | undefined };
      sessionId = target._session?.()?.id();
    } catch {
      sessionId = undefined;
    }
    if (!sessionId) {
      return;
    }
    this.unguardedTargetSessions.delete(sessionId);
    const guard = this.targetGuardSessions.get(sessionId);
    if (!guard) {
      return;
    }
    if (guard.pendingRequests.size) {
      await Promise.allSettled([...guard.pendingRequests]);
    }
    guard.released = true;
    removeCdpListener(guard.session, "Fetch.requestPaused", guard.requestPausedListener);
    removeCdpListener(guard.session, "disconnected", guard.disconnectedListener);
    restoreGuardSend(guard);
    this.targetGuardSessions.delete(sessionId);
    // Page.setRequestInterception owns Fetch.enable from this point onward;
    // disabling here would race that setup and create an interception gap.
  }

  private async prepareTarget(target: { type(): string; page(): Promise<Page | null> }): Promise<void> {
    const generation = this.lifecycleGeneration;
    try {
      if (target.type() !== "page" || this.shuttingDown) {
        return;
      }
      const page = await target.page();
      if (!page || isPageClosed(page) || !this.isBrowserGenerationCurrent(generation)) {
        return;
      }
      if (this.targetGuardUnavailable || this.isUnguardedTargetPage(page)) {
        // A connected browser without Fetch interception support cannot be
        // trusted for a target whose initial request has not been checked.
        await closePageSafely(page);
        return;
      }
      const state = this.stateFor(page);
      try {
        await this.configurePage(state);
        await this.releaseTargetGuardForPage(page);
        this.assertStateLive(state);
      } catch (error) {
        await this.disposePageState(state);
        throw error;
      }
    } catch (error) {
      this.logger.warn("New browser tab could not be prepared", { error: String(error) });
    }
  }

  private isUnguardedTargetPage(page: Page): boolean {
    try {
      const target = page.target() as unknown as { _session?: () => CDPSession | undefined };
      const sessionId = target._session?.()?.id();
      return Boolean(sessionId && this.unguardedTargetSessions.has(sessionId));
    } catch {
      return false;
    }
  }

  private async newPageState(signal?: AbortSignal): Promise<PageState> {
    const generation = this.lifecycleGeneration;
    const browser = await this.ensureBrowser(signal);
    throwIfAborted(signal);
    let page: Page;
    try {
      page = await browser.newPage();
    } catch (error) {
      if (!this.isCurrentBrowser(browser, generation)) {
        throw this.browserLifecycleError();
      }
      throw normalizeBrowserOperationError(error, signal);
    }
    if (!this.isCurrentBrowser(browser, generation)) {
      await closePageSafely(page);
      throw this.browserLifecycleError();
    }
    let state: PageState | undefined;
    try {
      throwIfAborted(signal);
      state = this.stateFor(page);
      await this.configurePage(state, signal);
      await this.releaseTargetGuardForPage(page);
      this.assertStateLive(state);
      return state;
    } catch (error) {
      if (state) {
        await this.disposePageState(state);
      } else {
        await closePageSafely(page);
      }
      throw error;
    }
  }

  private async disposePageState(state: PageState): Promise<void> {
    this.retireState(state);
    await closePageSafely(state.page);
  }

  private async disposeStalePageState(state: PageState): Promise<void> {
    if (state.disposed || state.lifecycleGeneration !== this.lifecycleGeneration || isPageClosed(state.page)) {
      await this.disposePageState(state);
    }
  }

  private retireState(state: PageState): void {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    this.removePageListeners(state);
    state.refs.clear();
    state.snapshotInteractive = undefined;
    state.snapshotId = undefined;
    state.dialogs.length = 0;
    state.navigationError = undefined;
    state.activeNavigationGeneration = undefined;
    if (this.states.get(state.id) === state) {
      this.states.delete(state.id);
    }
    if (this.currentPageId === state.id) {
      this.currentPageId = undefined;
    }
  }

  private retireAllStates(): void {
    for (const state of this.states.values()) {
      this.retireState(state);
    }
    this.states.clear();
    this.currentPageId = undefined;
  }

  private removePageListeners(state: PageState): void {
    const remove = (listenerRemoval: () => void): void => {
      try {
        listenerRemoval();
      } catch {
        // A disconnected or already-disposed page may reject listener access.
      }
    };
    remove(() => {
      if (state.networkRequestListener) {
        state.page.off("request", state.networkRequestListener);
      }
    });
    remove(() => {
      if (state.networkResponseListener) {
        state.page.off("response", state.networkResponseListener);
      }
    });
    remove(() => {
      if (state.consoleListener) {
        state.page.off("console", state.consoleListener);
      }
    });
    remove(() => {
      if (state.dialogListener) {
        state.page.off("dialog", state.dialogListener);
      }
    });
    remove(() => {
      if (state.frameNavigatedListener) {
        state.page.off("framenavigated", state.frameNavigatedListener);
      }
    });
    remove(() => {
      if (state.frameAttachedListener) {
        state.page.off("frameattached", state.frameAttachedListener);
      }
    });
    remove(() => {
      if (state.frameDetachedListener) {
        state.page.off("framedetached", state.frameDetachedListener);
      }
    });
    remove(() => {
      if (state.pageCloseListener) {
        state.page.off("close", state.pageCloseListener);
      }
    });
    remove(() => {
      if (state.navigationRequestListener) {
        state.page.off("request", state.navigationRequestListener);
      }
    });
    state.networkRequestListener = undefined;
    state.networkResponseListener = undefined;
    state.consoleListener = undefined;
    state.dialogListener = undefined;
    state.frameNavigatedListener = undefined;
    state.frameAttachedListener = undefined;
    state.frameDetachedListener = undefined;
    state.pageCloseListener = undefined;
    state.navigationRequestListener = undefined;
    state.listenersInstalled = false;
    state.navigationGuardInstalled = false;
  }

  private assertStateLive(state: PageState): void {
    if (state.disposed || this.states.get(state.id) !== state || state.lifecycleGeneration !== this.lifecycleGeneration || isPageClosed(state.page)) {
      throw new AppError("BROWSER_CONNECT_FAILED", "The browser page is no longer available.", { retryable: true });
    }
  }

  private isBrowserGenerationCurrent(generation: number): boolean {
    return !this.shuttingDown && generation === this.lifecycleGeneration && this.browser !== undefined;
  }

  private isCurrentBrowser(browser: Browser, generation: number): boolean {
    return this.isBrowserGenerationCurrent(generation) && this.browser === browser;
  }

  private browserLifecycleError(): AppError {
    return this.shuttingDown
      ? new AppError("SERVER_CLOSING", "The browser runtime is shutting down.", { retryable: true })
      : new AppError("BROWSER_CONNECT_FAILED", "The browser connection changed while the action was starting.", { retryable: true });
  }

  private async configurePage(state: PageState, signal?: AbortSignal): Promise<void> {
    this.assertStateLive(state);
    throwIfAborted(signal);
    if (state.configurationPromise) {
      await awaitWithAbort(state.configurationPromise, signal);
      this.assertStateLive(state);
      return;
    }
    const configuration = this.configurePageUnlocked(state, signal);
    const trackedConfiguration = configuration.finally(() => {
      if (state.configurationPromise === trackedConfiguration) {
        state.configurationPromise = undefined;
      }
    });
    state.configurationPromise = trackedConfiguration;
    await awaitWithAbort(trackedConfiguration, signal);
    this.assertStateLive(state);
  }

  private async configurePageUnlocked(state: PageState, signal?: AbortSignal): Promise<void> {
    this.assertStateLive(state);
    if (!state.timeoutsConfigured) {
      state.page.setDefaultTimeout(this.config.browser.actionTimeoutMs);
      state.page.setDefaultNavigationTimeout(this.config.browser.actionTimeoutMs);
      state.timeoutsConfigured = true;
    }
    if (!state.downloadConfigured) {
      try {
        const downloadPath = resolve(this.config.dataDir, "downloads");
        await mkdir(downloadPath, { recursive: true, mode: 0o700 });
        try {
          // Puppeteer exposes the context at runtime, while its stable public
          // BrowserContext type does not yet declare this CDP-backed helper.
          const context = state.page.browserContext() as unknown as { setDownloadBehavior?: (behavior: { policy: "allow"; downloadPath: string }) => Promise<void> };
          if (!context.setDownloadBehavior) {
            throw new AppError("DOWNLOAD_CONFIGURATION_FAILED", "The connected browser does not expose context download behavior.");
          }
          if (!this.configuredDownloadContexts.has(context)) {
            await context.setDownloadBehavior({ policy: "allow", downloadPath });
            this.configuredDownloadContexts.add(context);
          }
          state.downloadConfigured = true;
        } catch {
          // Older Chromium versions expose only the page-scoped command.
          const client = await state.page.createCDPSession();
          try {
            await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath });
            state.downloadConfigured = true;
          } finally {
            await client.detach().catch(() => undefined);
          }
        }
      } catch (error) {
        this.logger.warn("Browser download behavior could not be configured", { pageId: state.id, error: String(error) });
      }
    }
    this.assertStateLive(state);
    if (!state.navigationGuardInstalled) {
      try {
        await this.waitForTargetGuardDrain(state.page, signal);
        throwIfAborted(signal);
        const navigationRequestListener = (request: HTTPRequest): void => {
          void this.handleRequest(state, request);
        };
        state.navigationRequestListener = navigationRequestListener;
        // Install the handler before enabling interception so no request can
        // arrive in the gap between those two operations.
        state.page.on("request", navigationRequestListener);
        await state.page.setRequestInterception(true);
        state.navigationGuardInstalled = true;
      } catch (error) {
        if (state.navigationRequestListener) {
          state.page.off("request", state.navigationRequestListener);
          state.navigationRequestListener = undefined;
        }
        throw new AppError("BROWSER_GUARD_FAILED", "The browser navigation policy could not be installed.", { retryable: true, cause: error });
      }
    }
  }

  private async handleRequest(state: PageState, request: HTTPRequest): Promise<void> {
    let requestUrl = "";
    let requestFrame: Frame | null = null;
    let navigationRequest = false;
    let mainFrameNavigation = false;
    let navigationGeneration: number | undefined;
    try {
      if (state.disposed) {
        if (!request.isInterceptResolutionHandled()) {
          await request.continue();
        }
        return;
      }
      if (request.isInterceptResolutionHandled()) {
        return;
      }
      navigationRequest = request.isNavigationRequest();
      requestFrame = request.frame();
      const isFrameNavigation = navigationRequest && requestFrame !== null;
      mainFrameNavigation = isFrameNavigation && requestFrame === state.page.mainFrame();
      navigationGeneration = mainFrameNavigation ? state.activeNavigationGeneration : undefined;
      requestUrl = request.url();
      if (/^about:blank(?:#.*)?$/i.test(requestUrl)) {
        await request.continue();
        return;
      }
      if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
        if (isFrameNavigation) {
          throw new AppError("URL_BLOCKED", "Data and blob frame navigations are disabled by policy.");
        }
        await request.continue();
        return;
      }
      if (!/^https?:\/\//i.test(requestUrl)) {
        if (/^wss?:\/\//i.test(requestUrl)) {
          await this.policy.assertNavigationAllowedAsync(requestUrl.replace(/^ws/i, "http"));
          await request.continue();
          return;
        }
        throw new AppError("URL_BLOCKED", "Unsupported browser URL schemes are disabled by policy.");
      }
      // Apply the same domain, credential, blocked-host, and private-network
      // policy to every HTTP(S) request, not only top-level navigations. This
      // prevents an allowed page from using fetch/XHR/WebSocket-like browser
      // requests to reach a private service behind the MCP boundary.
      await this.policy.assertNavigationAllowedAsync(requestUrl);
      await request.continue();
    } catch (error) {
      const normalized = error instanceof AppError ? error : new AppError("NAVIGATION_BLOCKED", "The browser navigation was blocked by policy.", { cause: error });
      this.logger.warn("Browser navigation blocked", { pageId: state.id, url: safeUrl(requestUrl), code: normalized.code });
      if (mainFrameNavigation && navigationGeneration !== undefined) {
        if (!state.navigationError || state.navigationError.generation !== navigationGeneration) {
          state.navigationError = { generation: navigationGeneration, error: normalized };
        }
      }
      let handled = true;
      try {
        handled = request.isInterceptResolutionHandled();
      } catch {
        // A disposed request cannot be resolved anymore; avoid issuing a
        // second CDP command from the error path.
      }
      if (!handled) {
        await request.abort("blockedbyclient").catch(() => undefined);
      }
    }
  }

  private stateFor(page: Page): PageState {
    const existingId = this.ids.get(page);
    if (existingId) {
      const existing = this.states.get(existingId);
      if (existing) {
        return existing;
      }
      this.ids.delete(page);
    }
    const state: PageState = { id: randomUUID(), page, lifecycleGeneration: this.lifecycleGeneration, disposed: false, refs: new Map(), domRevision: 0, networkEnabled: false, consoleEnabled: false, network: [], console: [], dialogs: [], listenersInstalled: false, timeoutsConfigured: false, downloadConfigured: false, navigationGuardInstalled: false, navigationGeneration: 0, challengeActive: false };
    this.ids.set(page, state.id);
    this.states.set(state.id, state);
    this.installListeners(state);
    return state;
  }

  private installListeners(state: PageState): void {
    if (state.listenersInstalled) {
      return;
    }
    state.listenersInstalled = true;
    const networkRequestListener = (request: HTTPRequest): void => {
      if (state.disposed || !state.networkEnabled) {
        return;
      }
      try {
        state.network.push({ timestamp: new Date().toISOString(), type: "request", url: safeUrl(request.url()), method: request.method() });
        trimLog(state.network);
      } catch (error) {
        this.logger.debug("Browser request log entry was unavailable after page disposal", { pageId: state.id, error: String(error) });
      }
    };
    state.networkRequestListener = networkRequestListener;
    state.page.on("request", networkRequestListener);
    const networkResponseListener = (response: HTTPResponse): void => {
      if (state.disposed) {
        return;
      }
      try {
        if (response.request().isNavigationRequest() && response.frame() === state.page.mainFrame()) {
          state.mainFrameStatus = response.status();
        }
        if (state.networkEnabled) {
          state.network.push({ timestamp: new Date().toISOString(), type: "response", url: safeUrl(response.url()), status: response.status() });
          trimLog(state.network);
        }
      } catch (error) {
        // A response can race page disposal; the internal status/log is
        // advisory and must not escape the Puppeteer event callback.
        this.logger.debug("Browser response log entry was unavailable after page disposal", { pageId: state.id, error: String(error) });
      }
    };
    state.networkResponseListener = networkResponseListener;
    state.page.on("response", networkResponseListener);
    const consoleListener = (message: ConsoleMessage): void => {
      if (state.disposed || !state.consoleEnabled) {
        return;
      }
      try {
        state.console.push({ timestamp: new Date().toISOString(), type: "console", level: message.type(), text: message.text().slice(0, 2_000) });
        trimLog(state.console);
      } catch (error) {
        this.logger.debug("Browser console log entry was unavailable after page disposal", { pageId: state.id, error: String(error) });
      }
    };
    state.consoleListener = consoleListener;
    state.page.on("console", consoleListener);
    const dialogListener = (dialog: Dialog): void => {
      if (state.disposed) {
        return;
      }
      try {
        const type = dialog.type();
        state.dialogs.push({ dialog, type, text: dialog.message().slice(0, 4_000) });
        this.currentPageId = state.id;
        this.logger.info("Browser dialog opened", { pageId: state.id, type });
      } catch (error) {
        this.logger.debug("Browser dialog event was unavailable after page disposal", { pageId: state.id, error: String(error) });
      }
    };
    state.dialogListener = dialogListener;
    state.page.on("dialog", dialogListener);
    const frameNavigatedListener = (frame: Frame): void => {
      if (state.disposed) {
        return;
      }
      state.domRevision += 1;
      state.snapshotId = undefined;
      state.refs.clear();
      state.snapshotInteractive = undefined;
      try {
        const mainFrame = state.page.mainFrame();
        if (frame === mainFrame && mainFrame.url() !== "about:blank") {
          state.challengeActive = false;
        }
      } catch (error) {
        this.logger.debug("Browser frame navigation event was unavailable after page disposal", { pageId: state.id, error: String(error) });
      }
    };
    state.frameNavigatedListener = frameNavigatedListener;
    state.page.on("framenavigated", frameNavigatedListener);
    const frameAttachedListener = (): void => {
      if (state.disposed) {
        return;
      }
      state.domRevision += 1;
      state.snapshotId = undefined;
      state.refs.clear();
      state.snapshotInteractive = undefined;
    };
    state.frameAttachedListener = frameAttachedListener;
    state.page.on("frameattached", frameAttachedListener);
    const frameDetachedListener = (frame: Frame): void => {
      if (state.disposed) {
        return;
      }
      state.domRevision += 1;
      state.snapshotId = undefined;
      state.refs.clear();
      state.snapshotInteractive = undefined;
      FRAME_IDS.delete(frame);
    };
    state.frameDetachedListener = frameDetachedListener;
    state.page.on("framedetached", frameDetachedListener);
    const pageCloseListener = (): void => {
      this.retireState(state);
    };
    state.pageCloseListener = pageCloseListener;
    state.page.on("close", pageCloseListener);
  }

  private dialogState(pageId?: string): PageState | undefined {
    if (pageId) {
      const resolvedPageId = this.resolvePageId(pageId);
      return resolvedPageId ? this.states.get(resolvedPageId) : undefined;
    }
    return this.currentPageId ? this.states.get(this.currentPageId) : [...this.states.values()][0];
  }

  private assertNoPendingDialog(pageId?: string): void {
    const pendingState = this.dialogState(pageId);
    if (pendingState?.dialogs.length) {
      throw new AppError("DIALOG_PENDING", `Resolve the ${pendingState.dialogs[0].type} dialog on page '${pendingState.id}' before using browser actions.`, { retryable: true, details: { pageId: pendingState.id, type: pendingState.dialogs[0].type } });
    }
  }

  private assertSnapshotForAction(state: PageState, action: BrowserAction): void {
    const target = elementReferenceForAction(action);
    if (!action.snapshotId || !target) {
      return;
    }
    if (!state.snapshotId || state.snapshotId !== action.snapshotId) {
      throw new AppError("STALE_REFERENCE", "The action was based on an older browser snapshot. Capture a fresh snapshot and retry.", { retryable: true });
    }
  }

  private async listFrames(state: PageState): Promise<FrameSummary[]> {
    const pageUrl = state.page.url();
    const pageOrigin = safeOrigin(pageUrl);
    const summaries = await Promise.all(state.page.frames().filter((frame) => !isFrameDetached(frame)).slice(0, 64).map(async (frame): Promise<FrameSummary | undefined> => {
      try {
        const url = frame.url();
        const origin = safeOrigin(url);
        let title = "";
        if (origin === pageOrigin || frame === state.page.mainFrame()) {
          title = await frame.title().catch(() => "");
        }
        const parent = frame.parentFrame();
        return {
          frameId: framePath(frame),
          parentFrameId: parent ? framePath(parent) : null,
          url: safeUrl(url),
          origin: origin || null,
          sameOrigin: Boolean(origin && pageOrigin && origin === pageOrigin),
          title: wrapUntrustedText("frame_title", redactSecretPlaceholders(title.slice(0, 500)), 500),
        };
      } catch (error) {
        if (isFrameDetached(frame)) {
          return undefined;
        }
        throw error;
      }
    }));
    return summaries.filter((summary): summary is FrameSummary => summary !== undefined);
  }

  private async accessibilitySnapshot(state: PageState, maxNodes: number, maxChars: number, interestingOnly: boolean): Promise<unknown> {
    const client = await state.page.createCDPSession();
    try {
      const response = await client.send("Accessibility.getFullAXTree", {}) as unknown as { nodes?: Array<Record<string, unknown>> };
      const sourceNodes = Array.isArray(response.nodes) ? response.nodes : [];
      const nodes = sourceNodes
        .filter((node) => !interestingOnly || isInterestingAxNode(node))
        .slice(0, Math.max(1, Math.floor(maxNodes)))
        .map((node, index) => {
          const role = axValue(node.role);
          const name = axValue(node.name);
          const value = axValue(node.value);
          const properties = Array.isArray(node.properties)
            ? node.properties.slice(0, 20).reduce<Record<string, string>>((result, property) => {
              if (property && typeof property === "object") {
                const item = property as Record<string, unknown>;
                const key = typeof item.name === "string" ? item.name : "";
                const itemValue = axValue(item.value);
                if (key && itemValue) {
                  result[key.slice(0, 200)] = wrapUntrustedText("accessibility_property", redactSecretPlaceholders(itemValue), 200);
                }
              }
              return result;
            }, {})
            : {};
          return {
            ref: `ax-${index + 1}`,
            role: role ? role.slice(0, 200) : "unknown",
            name: wrapUntrustedText("accessibility_name", redactSecretPlaceholders(name.slice(0, 500)), 500),
            ...(value ? { value: wrapUntrustedText("accessibility_value", redactSecretPlaceholders(value.slice(0, 500)), 500) } : {}),
            properties,
          };
        });
      const boundedNodes = boundAccessibilityNodes(nodes, maxChars);
      return {
        pageId: state.id,
        // Only advertise a registered snapshot id; fabricating one here would
        // let clients act on an id that PageState never recorded.
        ...(state.snapshotId ? { snapshotId: state.snapshotId } : {}),
        nodes: boundedNodes.nodes,
        truncated: sourceNodes.length > nodes.length || boundedNodes.truncated,
      };
    } finally {
      await client.detach().catch(() => undefined);
    }
  }

  private async frameFor(state: PageState, frameId?: string): Promise<Frame> {
    this.assertStateLive(state);
    const expected = frameId ?? "main";
    let frames: Frame[];
    try {
      frames = state.page.frames();
    } catch (error) {
      throw new AppError("FRAME_NOT_FOUND", `Frame '${expected}' was not found. Refresh browser_frames and retry.`, { retryable: true, cause: error });
    }
    const frame = frames.find((candidate) => {
      if (isFrameDetached(candidate)) {
        return false;
      }
      try {
        return framePath(candidate) === expected;
      } catch {
        return false;
      }
    });
    if (!frame) {
      throw new AppError("FRAME_NOT_FOUND", `Frame '${expected}' was not found. Refresh browser_frames and retry.`, { retryable: true });
    }
    try {
      const url = frame.url();
      if (url !== "about:blank") {
        await this.policy.assertNavigationAllowedAsync(url);
      }
    } catch (error) {
      if (isFrameDetached(frame)) {
        throw new AppError("FRAME_NOT_FOUND", `Frame '${expected}' was not found. Refresh browser_frames and retry.`, { retryable: true });
      }
      throw error;
    }
    return frame;
  }

  private async selectorFor(state: PageState, target: string, requestedFrameId?: string): Promise<string> {
    this.assertStateLive(state);
    const normalized = target.trim();
    const ref = normalized.startsWith("ref:") ? normalized.slice(4) : normalized;
    if (/^e\d+$/.test(ref)) {
      const stored = state.refs.get(ref);
      if (!stored || stored.snapshotId !== state.snapshotId) {
        throw new AppError("STALE_REFERENCE", `Element reference '${ref}' is stale. Capture a fresh browser snapshot before acting.`, { retryable: true });
      }
      const effectiveFrameId = requestedFrameId ?? "main";
      if (effectiveFrameId !== stored.frameId) {
        throw new AppError("FRAME_MISMATCH", `Reference '${ref}' belongs to frame '${stored.frameId}', not '${effectiveFrameId}'.`, { retryable: true });
      }
      const frame = await this.frameFor(state, stored.frameId);
      const currentSignature = await frame.$eval(stored.selector, (element) => {
        const htmlElement = element as HTMLElement & { type?: string };
        const anchor = element.closest("a") as HTMLAnchorElement | null;
        const rect = element.getBoundingClientRect();
        return [
          element.tagName.toLowerCase(),
          element.getAttribute("role") ?? "",
          element.getAttribute("aria-label") ?? "",
          htmlElement.type ?? "",
          (htmlElement.innerText || element.getAttribute("value") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          anchor?.href ?? "",
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ].join("\u001f");
      }).catch(() => undefined);
      if (!currentSignature || currentSignature !== stored.signature) {
        throw new AppError("STALE_REFERENCE", `Element reference '${ref}' no longer identifies the same element. Capture a fresh browser snapshot before acting.`, { retryable: true });
      }
      return stored.selector;
    }
    try {
      const frame = await this.frameFor(state, requestedFrameId);
      const handle = await frame.$(normalized);
      await handle?.dispose().catch(() => undefined);
      return normalized;
    } catch (error) {
      if (isSelectorSyntaxError(error)) {
        throw new AppError("SELECTOR_INVALID", `The selector '${normalized.slice(0, 200)}' is invalid.`, { cause: error });
      }
      throw error;
    }
  }

  private async clickSnapshotRef(state: PageState, target: string, frame: Frame): Promise<{ selector: string; descriptor: ClickDescriptor & { href?: string; rect: { x: number; y: number; width: number; height: number } } }> {
    const normalized = target.trim();
    const ref = normalized.startsWith("ref:") ? normalized.slice(4) : normalized;
    const stored = state.refs.get(ref);
    if (!/^e\d+$/.test(ref) || !stored || stored.snapshotId !== state.snapshotId) {
      throw new AppError("STALE_REFERENCE", `Element reference '${ref}' is stale. Capture a fresh browser snapshot before acting.`, { retryable: true });
    }
    const effectiveFrameId = framePath(frame);
    if (effectiveFrameId !== stored.frameId) {
      throw new AppError("FRAME_MISMATCH", `Reference '${ref}' belongs to frame '${stored.frameId}', not '${effectiveFrameId}'.`, { retryable: true });
    }
    const evaluated = await frame.$eval(stored.selector, (element) => {
      const clickable = element.closest("a,button,input,select,textarea,[role=button]") ?? element;
      const htmlElement = clickable as HTMLElement & { type?: string; value?: string };
      const anchor = clickable.closest("a") as HTMLAnchorElement | null;
      const rect = clickable.getBoundingClientRect();
      return {
        signature: [
          element.tagName.toLowerCase(),
          element.getAttribute("role") ?? "",
          element.getAttribute("aria-label") ?? "",
          htmlElement.type ?? "",
          (htmlElement.innerText || element.getAttribute("value") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          anchor?.href ?? "",
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ].join("\u001f"),
        tag: clickable.tagName.toLowerCase(),
        type: htmlElement.type?.toLowerCase() ?? "",
        role: clickable.getAttribute("role") ?? "",
        label: [clickable.textContent, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
        href: anchor?.href ?? (clickable as HTMLAnchorElement).href ?? clickable.getAttribute("href") ?? undefined,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }).catch(() => undefined);
    if (!evaluated || evaluated.signature !== stored.signature) {
      throw new AppError("STALE_REFERENCE", `Element reference '${ref}' no longer identifies the same element. Capture a fresh browser snapshot before acting.`, { retryable: true });
    }
    return { selector: stored.selector, descriptor: evaluated };
  }

  private async openLinkInNewTab(state: PageState, target: string, signal?: AbortSignal): Promise<unknown | undefined> {
    const browser = await this.ensureBrowser(signal);
    if (this.targetGuardUnavailable) {
      throw new AppError("POPUP_BLOCKED", "Opening a new tab is unavailable because the browser target policy guard could not be installed.", { retryable: true });
    }
    const beforePages = new Set(await browser.pages());
    const beforeUrl = state.page.url();
    let selector: string | undefined;
    try {
      selector = await this.selectorFor(state, target, "main");
    } catch (error) {
      if (shouldPropagateTargetError(error)) {
        throw error;
      }
      selector = undefined;
    }
    const href = selector
      ? await state.page.$eval(selector, (element) => {
        const anchor = element.closest("a") as HTMLAnchorElement | null;
        return anchor?.href ?? (element as HTMLAnchorElement).href ?? element.getAttribute("href");
      }).catch(() => undefined)
      : await state.page.evaluate((needle) => {
        const element = Array.from(document.querySelectorAll("body *")).find((candidate) => {
          const htmlElement = candidate as HTMLElement;
          return (htmlElement.innerText || candidate.textContent || "").trim() === needle;
        });
        const clickable = element?.closest("a,button,[role=button],[onclick]") as HTMLElement | null;
        const anchor = clickable?.closest("a") as HTMLAnchorElement | null;
        return anchor?.href ?? clickable?.getAttribute("href");
      }, target).catch(() => undefined);
    if (!href) {
      return undefined;
    }
    throwIfAborted(signal);
    const popupSeed: PopupObservation = { createdPages: new Set<Page>(), pendingPagePromises: new Set<Promise<void>>() };
    const popupPromise = this.waitForPopup(
      state.page,
      browser,
      beforePages,
      Math.min(this.config.browser.actionTimeoutMs, NEW_TAB_DETECTION_TIMEOUT_MS),
      signal,
      popupSeed,
    );
    let popupObservation: PopupObservation | undefined;
    try {
      // Perform the real click first so target=_blank, window.open, POST forms,
      // and page handlers retain their browser semantics.
      await this.clickTarget(state, target, "left", 1, signal);
      popupObservation = await popupPromise;
      await Promise.allSettled([...popupObservation.pendingPagePromises]);
      const popupCandidate = popupObservation.popup && !isPageClosed(popupObservation.popup) && !beforePages.has(popupObservation.popup) ? popupObservation.popup : undefined;
      const opened = popupCandidate ?? [...popupObservation.createdPages].find((candidate) => !isPageClosed(candidate) && !beforePages.has(candidate));
      if (opened) {
        const next = this.stateFor(opened);
        try {
          await this.configurePage(next, signal);
          await this.waitForPageReady(next.page, signal);
          await this.policy.assertNavigationAllowedAsync(next.page.url());
          this.assertStateLive(next);
        } catch (error) {
          await this.disposePageState(next);
          throw error;
        }
        this.currentPageId = next.id;
        return { clicked: true, openedPageId: next.id, url: safeUrl(next.page.url()) };
      }
      // Some sites prevent the popup event but still expose an ordinary anchor.
      // Only synthesize a tab when the real click left the current URL untouched;
      // this avoids issuing a second click for a stateful button.
      if (state.page.url() === beforeUrl) {
        const url = await this.resolveAllowedNavigation(state.page.url(), href);
        const next = await this.newPageState(signal);
        try {
          await next.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: this.config.browser.actionTimeoutMs, signal });
          await this.policy.assertNavigationAllowedAsync(next.page.url());
          this.assertStateLive(next);
        } catch (error) {
          await this.disposePageState(next);
          throw error;
        }
        this.currentPageId = next.id;
        return { clicked: true, openedPageId: next.id, url: safeUrl(next.page.url()), synthetic: true };
      }
      this.assertStateLive(state);
      return { clicked: true, pageId: state.id, url: safeUrl(state.page.url()) };
    } catch (error) {
      // A click can fail while the popup watcher is aborting. Always observe
      // that promise so its cancellation rejection cannot become unhandled.
      if (!popupObservation) {
        popupObservation = await popupPromise.catch(() => popupSeed);
      }
      await Promise.allSettled([...popupObservation.pendingPagePromises]);
      await this.disposeOpenedPages(popupObservation.createdPages);
      throw error;
    }
  }

  private async disposeOpenedPages(openedPages: Set<Page>): Promise<void> {
    // Only close targets observed as children of this click. Tabs opened by a
    // human or another client while the action was running are unrelated and
    // must remain untouched.
    const pages = [...openedPages];
    await Promise.all(pages
      .filter((page) => !isPageClosed(page))
      .map(async (page) => {
        const state = [...this.states.values()].find((candidate) => candidate.page === page);
        if (state) {
          await this.disposePageState(state);
        } else {
          await page.close().catch(() => undefined);
        }
      }));
  }

  private waitForPopup(page: Page, browser: Browser, beforePages: Set<Page>, timeoutMs: number, signal?: AbortSignal, seed?: PopupObservation): Promise<PopupObservation> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const observation = seed ?? { createdPages: new Set<Page>(), pendingPagePromises: new Set<Promise<void>>() };
      const finish = (popup?: Page): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        page.off("popup", onPopup);
        page.off("close", onPageClose);
        browser.off("targetcreated", onTargetCreated);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ...observation, popup });
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        page.off("popup", onPopup);
        page.off("close", onPageClose);
        browser.off("targetcreated", onTargetCreated);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onPopup = (popup: Page | null): void => {
        if (popup && !beforePages.has(popup) && !isPageClosed(popup)) {
          observation.createdPages.add(popup);
          finish(popup);
        }
      };
      const onTargetCreated = (target: Target): void => {
        try {
          if (target.type() !== "page") {
            return;
          }
          const opener = target.opener();
          if (opener && opener !== page.target()) {
            return;
          }
        } catch {
          return;
        }
        try {
          const pending = target.page().then((popup) => {
            if (popup && !beforePages.has(popup) && !isPageClosed(popup)) {
              observation.createdPages.add(popup);
              finish(popup);
            }
          }).catch(() => undefined);
          observation.pendingPagePromises.add(pending);
          void pending.finally(() => observation.pendingPagePromises.delete(pending)).catch(() => undefined);
        } catch {
          return;
        }
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      const onAbort = (): void => fail(new AppError("CANCELLED", "The browser action was cancelled."));
      const onPageClose = (): void => finish();
      if (signal?.aborted) {
        fail(new AppError("CANCELLED", "The browser action was cancelled."));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      page.on("popup", onPopup);
      page.on("close", onPageClose);
      browser.on("targetcreated", onTargetCreated);
    });
  }

  private async waitForPageReady(page: Page, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await page.waitForNetworkIdle({ idleTime: 100, timeout: Math.min(this.config.browser.actionTimeoutMs, 1_000), signal }).catch(() => {
      throwIfAborted(signal);
      return undefined;
    });
    throwIfAborted(signal);
  }

  private async waitForUrlPattern(page: Page, pattern: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (globMatches(page.url(), pattern)) {
      return;
    }
    if (typeof page.on !== "function" || typeof page.off !== "function") {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        throwIfAborted(signal);
        if (globMatches(page.url(), pattern)) {
          return;
        }
        await wait(Math.min(100, Math.max(1, deadline - Date.now())), signal);
      }
      throw new AppError("WAIT_TIMEOUT", `The URL did not match '${pattern}' within ${timeoutMs}ms.`, { retryable: true });
    }
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        page.off("framenavigated", onNavigated);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onNavigated = (): void => {
        try {
          if (globMatches(page.url(), pattern)) {
            finish(resolvePromise);
          }
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onAbort = (): void => finish(() => reject(new AppError("CANCELLED", "The browser action was cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new AppError("WAIT_TIMEOUT", `The URL did not match '${pattern}' within ${timeoutMs}ms.`, { retryable: true }))), timeoutMs);
      page.on("framenavigated", onNavigated);
      signal?.addEventListener("abort", onAbort, { once: true });
      onNavigated();
    });
  }

  private async clickTarget(state: PageState, target: string, button: "left" | "middle" | "right", clickCount: number, signal?: AbortSignal, frame: Frame = state.page.mainFrame()): Promise<ClickMonitorResult> {
    let selector: string | undefined;
    let clickDescriptor: (ClickDescriptor & { href?: string; rect: { x: number; y: number; width: number; height: number } }) | undefined;
    const normalizedTarget = target.trim();
    const ref = normalizedTarget.startsWith("ref:") ? normalizedTarget.slice(4) : normalizedTarget;
    if (/^e\d+$/.test(ref)) {
      const resolved = await this.clickSnapshotRef(state, normalizedTarget, frame);
      selector = resolved.selector;
      clickDescriptor = resolved.descriptor;
    } else {
      try {
        selector = await this.selectorFor(state, target, framePath(frame));
      } catch (error) {
        if (shouldPropagateTargetError(error)) {
          throw error;
        }
        selector = undefined;
      }
    }
    if (selector) {
      // A plain visible label such as "Continue" is also syntactically valid
      // CSS (as a tag name). Only take the selector path when it resolves to
      // an element; otherwise continue to the exact-text resolver below.
      const resolved = await frame.$(selector);
      await resolved?.dispose().catch(() => undefined);
      if (!resolved) {
        selector = undefined;
      }
    }
    if (selector) {
      clickDescriptor ??= await frame.$eval(selector, (element) => {
        const clickable = element.closest("a,button,input,select,textarea,[role=button]") ?? element;
        const htmlElement = clickable as HTMLElement & { type?: string; value?: string };
        const anchor = clickable.closest("a") as HTMLAnchorElement | null;
        return {
          tag: clickable.tagName.toLowerCase(),
          type: htmlElement.type?.toLowerCase() ?? "",
          role: clickable.getAttribute("role") ?? "",
          label: [clickable.textContent, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
          href: anchor?.href ?? (clickable as HTMLAnchorElement).href ?? clickable.getAttribute("href") ?? undefined,
          rect: (() => {
            const rect = clickable.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })(),
        };
      });
      this.assertClickTargetSafe(clickDescriptor);
      if (clickDescriptor.href) {
        await this.assertNavigationUrl(frame.url() || state.page.url(), clickDescriptor.href);
      }
      return this.clickElement(state, frame, selector, button, clickCount, signal);
    }
    if (button !== "left") {
      throw new AppError("INVALID_ACTION", "Exact visible-text clicks support only the left mouse button; use a selector or coordinates for other buttons.");
    }
    const targetBox = await frame.evaluate((needle) => {
      const candidates = Array.from(document.querySelectorAll("body *"));
      const element = candidates.find((candidate) => {
        const htmlElement = candidate as HTMLElement;
        return (htmlElement.innerText || candidate.textContent || "").trim() === needle;
      }) as HTMLElement | undefined;
      const clickable = element?.closest("a,button,input,select,textarea,[role=button],[onclick]") as HTMLElement | null;
      if (!clickable) {
        return undefined;
      }
      const rect = clickable.getBoundingClientRect();
      const htmlElement = clickable as HTMLElement & { type?: string; value?: string };
      const anchor = clickable.closest("a") as HTMLAnchorElement | null;
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
        tag: clickable.tagName.toLowerCase(),
        type: htmlElement.type?.toLowerCase() ?? "",
        role: clickable.getAttribute("role") ?? "",
        label: [clickable.textContent, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
        href: anchor?.href ?? clickable.getAttribute("href") ?? undefined,
      };
    }, target);
    if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) {
      throw new AppError("ELEMENT_NOT_FOUND", `No clickable element matched '${target.slice(0, 200)}'.`);
    }
    this.assertClickTargetSafe(targetBox);
    if (targetBox.href) {
      await this.assertNavigationUrl(state.page.url(), targetBox.href);
    }
    if (frame !== state.page.mainFrame()) {
      throw new AppError("FRAME_ACTION_UNSUPPORTED", "Exact-text clicks in child frames require a selector or snapshot ref.");
    }
    const monitor = await this.runClickAndMonitor(state.page, () => state.page.mouse.click(targetBox.x, targetBox.y, { button: "left", count: clickCount }), signal);
    await this.throwPendingNavigationError(state, signal);
    return monitor;
  }

  private assertClickTargetSafe(target: ClickDescriptor): void {
    if (target.tag === "input" && target.type === "file") {
      throw new AppError("USE_UPLOAD_TOOL", "File inputs cannot be activated through browser_click; use browser_upload with an allowed file path.");
    }
    if (target.tag === "select") {
      throw new AppError("USE_SELECT_TOOL", "Native select controls cannot be activated through browser_click; use browser_select or browser_dropdown_options.");
    }
    if ((target.tag === "button" || target.tag === "a" || target.role === "button") && /\bprint(?:\s+(?:page|this|document))?\b|\bsave\s+as\s+pdf\b/i.test(target.label)) {
      throw new AppError("USE_PDF_TOOL", "Print controls cannot be activated through browser_click; use browser_pdf when a rendered PDF is required.");
    }
  }

  private async clickElement(state: PageState, frame: Frame, selector: string, button: "left" | "middle" | "right", clickCount: number, signal?: AbortSignal): Promise<ClickMonitorResult> {
    let dialogObserved = false;
    let removeDialogListener: (() => void) | undefined;
    const dialogOpened = new Promise<null>((resolve) => {
      const onDialog = (): void => {
        dialogObserved = true;
        removeDialogListener?.();
        resolve(null);
      };
      state.page.on("dialog", onDialog);
      removeDialogListener = () => state.page.off("dialog", onDialog);
    });
    const click = this.runClickAndMonitor(state.page, () => frame.click(selector, { button, count: clickCount }), signal).then(
      (result) => result,
      (error: unknown) => {
        removeDialogListener?.();
        if (dialogObserved) {
          return { navigated: false, urlChanged: false };
        }
        throw error;
      },
    );
    const openedDialog = await Promise.race([click, dialogOpened]);
    removeDialogListener?.();
    if (openedDialog === null) {
      // Puppeteer finishes the input command after the dialog is resolved by
      // browser_dialog. Consume that eventual result before surfacing any
      // cancellation so it cannot become an unhandled rejection.
      void click.catch((error: unknown) => {
        this.logger.debug("Browser click completed after dialog resolution", { pageId: state.id, error: String(error) });
      });
      // The dialog event can win the race just before the click's monitoring
      // wait observes cancellation. Never report a successful click for a
      // request that was already cancelled (especially during shutdown).
      throwIfAborted(signal);
      return { navigated: false, urlChanged: false };
    }
    return openedDialog;
  }

  private async runClickAndMonitor(page: Page, trigger: () => Promise<void>, signal?: AbortSignal): Promise<ClickMonitorResult> {
    throwIfAborted(signal);
    const beforeUrl = typeof page.url === "function" ? page.url() : "";
    let navigated = false;
    const onFrameNavigated = (frame: Frame): void => {
      try {
        if (frame === page.mainFrame()) {
          navigated = true;
        }
      } catch {
        // Page disposal can race the navigation event; the click operation
        // will report its own lifecycle/cancellation result.
      }
    };
    page.on("framenavigated", onFrameNavigated);
    try {
      await trigger();
      await wait(50, signal);
      if (navigated) {
        await page.waitForNetworkIdle({ idleTime: 100, timeout: Math.min(this.config.browser.actionTimeoutMs, 1_000), signal }).catch(() => {
          throwIfAborted(signal);
        });
      }
      const url = typeof page.url === "function" ? page.url() : "";
      return { navigated, urlChanged: url !== beforeUrl, url };
    } finally {
      page.off("framenavigated", onFrameNavigated);
    }
  }

  private async assertCurrentPageAllowed(page: Page): Promise<void> {
    const url = page.url();
    if (url === "about:blank") {
      return;
    }
    await this.policy.assertNavigationAllowedAsync(url);
  }

  private async assertNavigationUrl(baseUrl: string, rawUrl: string): Promise<void> {
    await this.resolveAllowedNavigation(baseUrl, rawUrl);
  }

  private async resolveAllowedNavigation(baseUrl: string, rawUrl: string): Promise<URL> {
    let resolved: URL;
    try {
      resolved = new URL(rawUrl, baseUrl);
    } catch (error) {
      throw new AppError("URL_INVALID", "The clicked link did not contain a valid URL.", { cause: error });
    }
    return this.policy.assertNavigationAllowedAsync(resolved.toString());
  }

  private beginNavigation(state: PageState): number {
    const generation = state.navigationGeneration + 1;
    state.navigationGeneration = generation;
    state.activeNavigationGeneration = generation;
    state.navigationError = undefined;
    state.mainFrameStatus = undefined;
    return generation;
  }

  private takeNavigationError(state: PageState, generation = state.activeNavigationGeneration): AppError | undefined {
    const record = state.navigationError;
    if (!record || generation === undefined || record.generation !== generation) {
      return undefined;
    }
    state.navigationError = undefined;
    return record.error;
  }

  private throwNavigationError(state: PageState, generation = state.activeNavigationGeneration): void {
    const error = this.takeNavigationError(state, generation);
    if (generation !== undefined && state.activeNavigationGeneration === generation) {
      state.activeNavigationGeneration = undefined;
    }
    if (error) {
      throw error;
    }
  }

  private async throwPendingNavigationError(state: PageState, signal?: AbortSignal, generation = state.activeNavigationGeneration): Promise<void> {
    await nextEventLoop(signal);
    this.throwNavigationError(state, generation);
  }

  private async inputTarget(state: PageState, target: string, text: string, clear: boolean, verify: boolean, frame: Frame = state.page.mainFrame(), signal?: AbortSignal): Promise<{ verified?: boolean }> {
    const selector = await this.selectorFor(state, target, framePath(frame));
    const input = await frame.$(selector);
    if (!input) {
      throw new AppError("ELEMENT_NOT_FOUND", `No input matched '${target.slice(0, 200)}'.`);
    }
    try {
      throwIfAborted(signal);
      await input.focus();
      throwIfAborted(signal);
      if (clear) {
        const modifier = platform === "darwin" ? "Meta" : "Control";
        await state.page.keyboard.down(modifier);
        try {
          await state.page.keyboard.press("A");
          // Selecting all is not itself a mutation. Backspace commits the
          // deletion (and the browser's normal input event) even when the new
          // text is the empty string.
          await state.page.keyboard.press("Backspace");
        } finally {
          await state.page.keyboard.up(modifier).catch(() => undefined);
        }
      }
      throwIfAborted(signal);
      await state.page.keyboard.type(text);
      throwIfAborted(signal);
      if (!verify) {
        return {};
      }
      const value = await input.evaluate((element) => {
        const htmlElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        return "value" in htmlElement ? String(htmlElement.value) : htmlElement.innerText;
      });
      return { verified: clear ? value === text : value.endsWith(text) };
    } finally {
      await input.dispose().catch(() => undefined);
    }
  }

  private async sendKeys(page: Page, keys: string[], signal?: AbortSignal): Promise<void> {
    for (const key of keys) {
      throwIfAborted(signal);
      const parts = key.includes("+") && key.length < 100 ? key.split("+") : [];
      if (parts.length > 1 && parts.every((part) => part.length > 0)) {
        const main = parts.pop();
        const pressed: string[] = [];
        try {
          for (const modifier of parts) {
            throwIfAborted(signal);
            await page.keyboard.down(normalizeKeyInput(modifier));
            pressed.push(modifier);
          }
          if (main) {
            throwIfAborted(signal);
            await page.keyboard.press(normalizeKeyInput(main));
          }
        } finally {
          for (const modifier of pressed.reverse()) {
            await page.keyboard.up(normalizeKeyInput(modifier)).catch(() => undefined);
          }
        }
      } else {
        await page.keyboard.press(normalizeKeyInput(key));
      }
    }
  }

  private async screenshotBase64(page: Page, fullPage: boolean, maxBytes: number, format: "png" | "jpeg" = "png", quality = 80, maxDimension?: number): Promise<ScreenshotCapture> {
    const clip = maxDimension ? await this.screenshotClip(page, fullPage, maxDimension) : undefined;
    const viewport = page.viewport();
    let fullPageDimensions: { width: number; height: number } | undefined;
    if (!clip && (fullPage || !viewport)) {
      try {
        fullPageDimensions = await page.evaluate((captureFullPage) => ({
          width: Math.max(1, captureFullPage ? document.documentElement.scrollWidth : window.innerWidth),
          height: Math.max(1, captureFullPage ? document.documentElement.scrollHeight : window.innerHeight),
        }), fullPage);
      } catch {
        // Keep the viewport fallback for pages that close during capture.
      }
    }
    const width = clip
      ? Math.max(1, Math.round(clip.width * clip.scale))
      : boundedScreenshotDimension(fullPageDimensions?.width ?? viewport?.width ?? 0);
    const height = clip
      ? Math.max(1, Math.round(clip.height * clip.scale))
      : boundedScreenshotDimension(fullPageDimensions?.height ?? viewport?.height ?? 0);
    let currentQuality = quality;
    for (let attempt = 0; attempt < (format === "jpeg" ? 4 : 1); attempt += 1) {
      const screenshot = await page.screenshot({
        type: format,
        encoding: "base64",
        ...(clip ? { clip, captureBeyondViewport: true } : { fullPage }),
        ...(format === "jpeg" ? { quality: currentQuality } : {}),
      });
      const bytes = Math.ceil((screenshot.length * 3) / 4);
      if (bytes <= maxBytes) {
        return {
          screenshotBase64: screenshot,
          metadata: {
            width,
            height,
            bytes,
            format,
            fullPage,
            scale: clip?.scale ?? 1,
            ...(format === "jpeg" ? { quality: currentQuality } : {}),
          },
        };
      }
      currentQuality = Math.max(30, currentQuality - 15);
    }
    throw new AppError("OUTPUT_TOO_LARGE", `The screenshot exceeded the ${maxBytes}-byte output limit.`);
  }

  private async screenshotClip(page: Page, fullPage: boolean, maxDimension: number): Promise<{ x: number; y: number; width: number; height: number; scale: number } | undefined> {
    const metrics = await page.evaluate(() => ({
      viewportWidth: Math.max(1, window.innerWidth),
      viewportHeight: Math.max(1, window.innerHeight),
      documentWidth: Math.max(1, document.documentElement.scrollWidth),
      documentHeight: Math.max(1, document.documentElement.scrollHeight),
      scrollX: Math.max(0, window.scrollX),
      scrollY: Math.max(0, window.scrollY),
    }));
    const width = fullPage ? metrics.documentWidth : metrics.viewportWidth;
    const height = fullPage ? metrics.documentHeight : metrics.viewportHeight;
    const scale = Math.min(1, Math.max(1, maxDimension) / Math.max(width, height));
    if (scale >= 1) {
      return undefined;
    }
    const x = fullPage ? 0 : Math.min(metrics.scrollX, Math.max(0, metrics.documentWidth - width));
    const y = fullPage ? 0 : Math.min(metrics.scrollY, Math.max(0, metrics.documentHeight - height));
    return { x, y, width, height, scale };
  }

  private async executeDialogAction(state: PageState, action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    this.assertStateLive(state);
    throwIfAborted(signal);
    switch (action.action) {
      case "alert_get_text":
        return {
          open: state.dialogs.length > 0,
          type: state.dialogs[0]?.type,
          text: state.dialogs[0] ? wrapUntrustedText("dialog_text", redactSecretPlaceholders(state.dialogs[0].text), 4_000) : "",
        };
      case "alert_accept":
        return this.resolveDialog(state, true, undefined, signal);
      case "alert_dismiss":
        return this.resolveDialog(state, false, undefined, signal);
      case "alert_send_keys":
        return this.resolveDialog(state, true, action.text ?? action.value ?? "", signal);
      default:
        throw new AppError("INVALID_ACTION", `Action '${action.action}' is not a dialog action.`);
    }
  }

  private async resolveDialog(state: PageState, accept: boolean, text?: string, signal?: AbortSignal): Promise<unknown> {
    const previous = state.dialogResolutionPromise;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    state.dialogResolutionPromise = current;
    try {
      if (previous) {
        await awaitWithAbort(previous, signal);
      }
      throwIfAborted(signal);
      const pending = state.dialogs.shift();
      if (!pending) {
        throw new AppError("DIALOG_NOT_FOUND", "No JavaScript dialog is currently open.");
      }
      try {
        if (accept) {
          await awaitWithAbort(pending.dialog.accept(text), signal);
        } else {
          await awaitWithAbort(pending.dialog.dismiss(), signal);
        }
      } catch (error) {
        // Remove a dialog after a failed CDP resolution too. Chromium may
        // have already handled it or the page may have closed; retaining it
        // would permanently block the page's control lane.
        throw error;
      }
      return { resolved: true, type: pending.type, accepted: accept };
    } finally {
      release();
      if (state.dialogResolutionPromise === current) {
        state.dialogResolutionPromise = undefined;
      }
    }
  }

  private async detectChallenge(state: PageState, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    try {
      const evidence = await state.page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText ?? "").slice(0, 200_000),
        html: document.documentElement.outerHTML.slice(0, 500_000),
        frameSources: Array.from(document.querySelectorAll("iframe[src]"), (frame) => frame.getAttribute("src") ?? "").slice(0, 100),
        visibleMarkers: Array.from(document.querySelectorAll("iframe,form,div,section"))
          .filter((element) => {
            const htmlElement = element as HTMLElement;
            const rect = htmlElement.getBoundingClientRect();
            const style = window.getComputedStyle(htmlElement);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          })
          .slice(0, 200)
          .map((element) => [element.tagName, element.id, element.getAttribute("class"), element.getAttribute("name"), element.getAttribute("src"), element.getAttribute("data-sitekey")].filter(Boolean).join(" ")),
      }));
      throwIfAborted(signal);
      const classification = classifyChallenge({ ...evidence, status: state.mainFrameStatus });
      if (classification.status === "present") {
        state.challengeActive = true;
      } else if (classification.status === "absent") {
        state.challengeActive = false;
      }
      return { ...classification, url: safeUrl(state.page.url()), title: wrapUntrustedText("challenge_title", redactSecretPlaceholders(evidence.title.slice(0, 1_000)), 1_000) };
    } catch {
      throwIfAborted(signal);
      // A failed probe is not evidence that a challenge is absent. Keep an
      // existing latch set and make human-wait callers distinguish this state.
      return {
        status: "unknown",
        detected: false,
        matches: [],
        humanActionRequired: true,
        bypassAttempted: false,
        verification: "unverified",
        url: safeUrl(state.page.url()),
      };
    }
  }

  private async waitForHuman(state: PageState, timeoutMs: number, pollMs: number, signal?: AbortSignal): Promise<unknown> {
    const startedAt = Date.now();
    throwIfAborted(signal);
    const initial = await this.detectChallenge(state, signal);
    let last: unknown = initial;
    if (isChallengeUnknown(initial)) {
      return { status: "unverified", resolution: "challenge_state_unverified", pageId: state.id, waitedMs: 0, initial, final: initial };
    }
    if (isChallengeAbsent(initial)) {
      return { status: "resolved", resolution: "no_challenge_at_start", pageId: state.id, waitedMs: 0, initial, final: initial };
    }
    while (Date.now() - startedAt <= timeoutMs) {
      throwIfAborted(signal);
      last = await this.detectChallenge(state, signal);
      if (isChallengeUnknown(last)) {
        await wait(pollMs, signal);
        continue;
      }
      if (isChallengeAbsent(last)) {
        return { status: "resolved", resolution: "challenge_cleared", pageId: state.id, waitedMs: Date.now() - startedAt, initial, final: last };
      }
      await wait(pollMs, signal);
    }
    return { status: "timed_out", resolution: "timeout", pageId: state.id, waitedMs: Date.now() - startedAt, initial, final: last };
  }

  private listDownloads(): Promise<unknown> {
    const downloadDir = resolve(this.config.dataDir, "downloads");
    return readdir(downloadDir, { withFileTypes: true })
      .then(async (entries) => {
        const listed = await Promise.all(entries
        .filter((entry) => entry.isFile())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 100)
        .map(async (entry) => {
          const filePath = join(downloadDir, entry.name);
          try {
            const fileStat = await stat(filePath);
            const partial = /\.(?:crdownload|part|tmp)$/i.test(entry.name);
            const relativePath = await this.serverRelativePath(filePath);
            return {
              name: wrapUntrustedText("download_name", redactSecretPlaceholders(entry.name), 512),
              path: wrapUntrustedText("download_path", redactSecretPlaceholders(relativePath), 1_024),
              size: Math.min(fileStat.size, Number.MAX_SAFE_INTEGER),
              extension: wrapUntrustedText("download_extension", redactSecretPlaceholders(extname(entry.name).slice(1, 128)), 128),
              modifiedAt: wrapUntrustedText("download_modified_at", redactSecretPlaceholders(fileStat.mtime.toISOString()), 128),
              status: partial ? "in_progress" : "complete",
            };
          } catch (error) {
            if (isMissingFile(error)) {
              return undefined;
            }
            throw error;
          }
        }));
        return listed.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      })
      .catch((error: unknown) => {
        if (isMissingFile(error)) {
          return [];
        }
        throw new AppError("DOWNLOADS_UNAVAILABLE", "Downloaded files could not be listed.", { cause: error });
      });
  }

  private async stageUploadFile(rawPath: string, signal?: AbortSignal): Promise<{ path: string; displayName: string; size: number }> {
    const candidate = this.policy.assertFilePath(rawPath, { mustExist: true });
    const before = await lstat(candidate).catch((error: unknown) => {
      throw new AppError("FILE_PATH_BLOCKED", "The upload source does not exist or cannot be resolved safely.", { cause: error });
    });
    if (before.isSymbolicLink()) {
      throw new AppError("FILE_PATH_BLOCKED", "The upload source must not be a symbolic link.");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let sourceHandle: FileHandle | undefined;
    let stagingPath: string | undefined;
    try {
      sourceHandle = await open(candidate, fsConstants.O_RDONLY | noFollow);
      const opened = await sourceHandle.stat();
      if (!opened.isFile()) {
        throw new AppError("FILE_PATH_BLOCKED", "The upload source must be a regular file.");
      }
      const after = await lstat(candidate);
      if (after.isSymbolicLink() || !sameFileIdentity(opened, after)) {
        throw new AppError("FILE_PATH_BLOCKED", "The upload source changed while it was being opened.", { retryable: true });
      }
      throwIfAborted(signal);
      const stagingDirectory = join(this.config.dataDir, "upload-staging");
      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      stagingPath = join(stagingDirectory, `.upload-${randomUUID()}`);
      const stagingHandle = await open(stagingPath, "wx", 0o600);
      try {
        // Copy from the already-open source handle rather than reopening the
        // path through a convenience copy helper. This keeps the bytes tied
        // to the identity checked above and makes cancellation observable at
        // chunk boundaries.
        for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
          throwIfAborted(signal);
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          let offset = 0;
          while (offset < buffer.byteLength) {
            const written = await stagingHandle.write(buffer, offset, buffer.byteLength - offset, null);
            if (written.bytesWritten <= 0) {
              throw new AppError("FILE_PATH_BLOCKED", "The upload source could not be staged safely.");
            }
            offset += written.bytesWritten;
          }
        }
        await stagingHandle.sync();
      } finally {
        await stagingHandle.close().catch(() => undefined);
      }
      throwIfAborted(signal);
      return { path: stagingPath, displayName: basename(candidate), size: opened.size };
    } catch (error) {
      if (stagingPath) {
        await unlinkIfPresent(stagingPath);
      }
      throw error instanceof AppError ? error : new AppError("FILE_PATH_BLOCKED", "The upload source could not be staged safely.", { cause: error });
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
  }

  private async outputFilePath(rawPath: string): Promise<string> {
    const candidate = this.policy.assertFilePath(rawPath);
    const parent = await realpath(dirname(candidate)).catch((error: unknown) => {
      throw new AppError("FILE_PATH_BLOCKED", "The output directory does not exist or cannot be resolved.", { cause: error });
    });
    const resolvedPath = join(parent, basename(candidate));
    this.policy.assertFilePath(resolvedPath);
    return resolvedPath;
  }

  private async serverRelativePath(filePath: string): Promise<string> {
    const dataRoot = await realpath(this.config.dataDir);
    const canonicalPath = await realpath(filePath);
    const result = relative(dataRoot, canonicalPath);
    if (result === "") {
      return basename(canonicalPath);
    }
    if (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`)) {
      return result;
    }
    return `external/${basename(canonicalPath)}`;
  }

  /** Reset browser/session if AbortSignal is ignored to prevent mutated target reuse. */
  private interruptBrowserOperation(): void {
    this.lifecycleGeneration += 1;
    this.detachTargetGuard();
    this.interruptedBrowserShutdown = undefined;
    const browser = this.browser;
    const owned = this.ownsBrowser;
    this.browser = undefined;
    this.ownsBrowser = false;
    this.retireAllStates();
    if (browser) {
      this.failedBrowserShutdown = { browser, owned };
      this.interruptedBrowserShutdown = closeConnectedBrowser(browser, owned, this.logger);
      void this.interruptedBrowserShutdown.then((succeeded) => {
        if (!succeeded) {
          this.browserShutdownFailure = true;
          this.recoveryRequired = true;
        } else {
          this.browserShutdownFailure = false;
          if (this.failedBrowserShutdown?.browser === browser) {
            this.failedBrowserShutdown = undefined;
          }
        }
      });
    }
  }

  private async recoverAfterAbort(operationPromise: Promise<unknown>): Promise<void> {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    const recovery = (async () => {
      const settled = await promiseSettledWithin(operationPromise, 250);
      if (settled) {
        return;
      }
      // The operation ignored its abort signal. Retire the entire old
      // lifecycle before allowing the serialized lane to advance.
      this.interruptBrowserOperation();
      const shutdown = this.interruptedBrowserShutdown;
      const succeeded = shutdown
        ? await settleWithTimeout(shutdown, SHUTDOWN_CONNECTION_SETTLE_TIMEOUT_MS)
        : true;
      if (succeeded !== true) {
        this.recoveryRequired = true;
      }
    })();
    this.recoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.recoveryPromise === recovery) {
        this.recoveryPromise = undefined;
      }
    }).catch(() => undefined);
    return recovery;
  }

  private async withOperationLock<T>(signal: AbortSignal | undefined, operation: (operationSignal: AbortSignal) => Promise<T>, queueTimeoutMs = this.config.browser.actionTimeoutMs, operationTimeoutMs?: number): Promise<T> {
    if (this.queuedOperations >= MAX_QUEUED_OPERATIONS) {
      throw new AppError("BROWSER_QUEUE_FULL", "The browser action queue is full; wait for an active operation to finish and retry.", { retryable: true, details: { hint: "Wait for the active browser operation to finish, then retry." } });
    }
    this.queuedOperations += 1;
    const requestSessionGeneration = this.sessionGeneration;
    const requestStartedAt = Date.now();
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queueSignal = combineSignals(signal, this.shutdownController.signal);
    let acquired = false;
    let deferRelease = false;
    let operationPromise: Promise<T> | undefined;
    try {
      await waitForTurn(previous, queueSignal, queueTimeoutMs);
      acquired = true;
      throwIfAborted(queueSignal);
      if (requestSessionGeneration !== this.sessionGeneration) {
        throw new AppError("SESSION_CLOSED", "The browser session was closed before this operation started.", { retryable: true });
      }
      const operationController = new AbortController();
      this.activeOperationController = operationController;
      const operationSignal = combineSignals(queueSignal, operationController.signal) ?? operationController.signal;
      let operationTimedOut = false;
      let abortRequested = false;
      let recoveryAfterAbort: Promise<void> | undefined;
      const operationBudgetMs = operationTimeoutMs === undefined
        ? undefined
        : Math.max(1, Math.floor(operationTimeoutMs) - Math.max(0, Date.now() - requestStartedAt));
      let removeAbortListener: (() => void) | undefined;
      let rejectAbort!: (error: unknown) => void;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
        const onAbort = (): void => {
          if (abortRequested) {
            return;
          }
          abortRequested = true;
          const timedOut = operationTimedOut;
          operationController.abort();
          reject(timedOut
            ? new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } })
            : new AppError("CANCELLED", "The browser action was cancelled."));
        };
        if (queueSignal?.aborted) {
          onAbort();
          return;
        }
        queueSignal?.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = (): void => queueSignal?.removeEventListener("abort", onAbort);
      });
      const deadlineTimer = operationTimeoutMs === undefined ? undefined : setTimeout(() => {
        if (!queueSignal?.aborted) {
          operationTimedOut = true;
          if (!abortRequested) {
            abortRequested = true;
            operationController.abort();
            rejectAbort(new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } }));
          }
        }
      }, operationBudgetMs);
      this.lastActivityAt = Date.now();
      operationPromise = Promise.resolve().then(() => operation(operationSignal));
      void operationPromise.catch(() => undefined);
      if (abortRequested) {
        recoveryAfterAbort = this.recoverAfterAbort(operationPromise);
      }
      try {
        const result = await Promise.race([operationPromise, abortPromise]);
        throwIfAborted(operationSignal);
        return result;
      } catch (error) {
        const normalized = normalizeBrowserOperationError(error, operationSignal);
        if (operationTimedOut && !queueSignal?.aborted) {
          throw new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) }, cause: error });
        }
        throw normalized;
      } finally {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
        removeAbortListener?.();
        if (this.activeOperationController === operationController) {
          this.activeOperationController = undefined;
        }
      if (abortRequested && operationPromise) {
        deferRelease = true;
        recoveryAfterAbort ??= this.recoverAfterAbort(operationPromise);
        await recoveryAfterAbort;
        deferRelease = false;
      }
      }
    } finally {
      this.queuedOperations -= 1;
      // A cancelled waiter must not resolve its queue node early: doing so
      // would let a later request run concurrently with the predecessor that
      // still owns the browser. Keep the node behind its predecessor even
      // when this request has already been cancelled.
      if (acquired) {
        if (!deferRelease) {
          release();
        }
      } else {
        void previous.then(release, release);
      }
    }
  }
}

async function awaitBrowserConnection(connection: Promise<Browser>, timeoutMs: number): Promise<Browser> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = new AppError("BROWSER_CONNECT_TIMEOUT", `The browser connection did not complete within ${timeoutMs}ms.`, { retryable: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([connection, deadline]);
  } catch (error) {
    if (timedOut) {
      // Puppeteer cannot cancel every in-flight launch/CDP handshake. The
      // caller tracks this raw promise until it settles and closes a late
      // browser exactly once before allowing another launch attempt.
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isBrowserConnectTimeout(error: unknown): boolean {
  return error instanceof AppError && error.code === "BROWSER_CONNECT_TIMEOUT";
}

async function closeConnectedBrowser(browser: Browser, owned: boolean, logger: Logger): Promise<boolean> {
  let succeeded = true;
  if (owned) {
    await Promise.resolve().then(() => browser.close()).catch((error: unknown) => {
      succeeded = false;
      logger.warn("Late browser close failed", { error: String(error) });
    });
  } else {
    await Promise.resolve().then(() => browser.disconnect()).catch((error: unknown) => {
      succeeded = false;
      logger.warn("Late browser disconnect failed", { error: String(error) });
    });
  }
  return succeeded;
}

async function closePageSafely(page: Page): Promise<void> {
  await Promise.resolve().then(() => page.close()).catch(() => undefined);
}

async function waitForElementState(
  frame: Frame,
  selector: string,
  state: "visible" | "hidden" | "attached" | "detached",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof (frame as unknown as { waitForFunction?: unknown }).waitForFunction === "function") {
    try {
      await (frame as unknown as { waitForFunction: (predicate: unknown, options: unknown, selector: string, state: string) => Promise<unknown> }).waitForFunction(
        (targetSelector: string, desiredState: string) => {
          const element = document.querySelector(targetSelector) as HTMLElement | null;
          const visible = Boolean(element && (() => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
          })());
          return desiredState === "attached"
            ? Boolean(element)
            : desiredState === "detached"
              ? !element
              : desiredState === "hidden"
                ? !visible
                : visible;
        },
        { timeout: timeoutMs, signal },
        selector,
        state,
      );
      return;
    } catch (error) {
      if (isPuppeteerTimeoutError(error)) {
        throw new AppError("WAIT_TIMEOUT", `The selector '${selector.slice(0, 200)}' did not become ${state} within ${timeoutMs}ms.`, { retryable: true, cause: error });
      }
      throw error;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfAborted(signal);
    let status: { visible: boolean } | undefined;
    try {
      status = await frame.$eval(selector, (element) => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return {
          visible: style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0"
            && rect.width > 0
            && rect.height > 0,
        };
      });
    } catch (error) {
      if (!isMissingElementError(error)) {
        throw error;
      }
    }
    const matched = state === "attached"
      ? status !== undefined
      : state === "detached"
        ? status === undefined
        : state === "hidden"
          ? status === undefined || !status.visible
          : status?.visible === true;
    if (matched) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AppError("WAIT_TIMEOUT", `The selector '${selector.slice(0, 200)}' did not become ${state} within ${timeoutMs}ms.`, { retryable: true });
    }
    await wait(Math.min(100, remaining), signal);
  }
}

function isMissingElementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:failed to find element matching selector|no element found for selector|cannot read properties of null)/i.test(message);
}

function isInvalidSelectorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:invalid selector|failed to execute ['"]queryselector|not a valid selector|is not a valid selector)/i.test(message);
}

function isPuppeteerTimeoutError(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "TimeoutError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /waiting failed:\s*\d+ms exceeded/i.test(message);
}

function normalizeBrowserOperationError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof AppError) {
    return error;
  }
  if (signal?.aborted) {
    return new AppError("CANCELLED", "The browser action was cancelled.", { cause: error });
  }
  if (isPuppeteerTimeoutError(error)) {
    return new AppError("BROWSER_TIMEOUT", "The browser operation exceeded its timeout.", { retryable: true, cause: error });
  }
  return error;
}

function batchFailureDetails(failedIndex: number, failedAction: string, completedResults: unknown[]): Record<string, unknown> {
  const boundedResults: unknown[] = [];
  let bytes = 2;
  for (const result of completedResults) {
    let resultBytes = 0;
    try {
      resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    } catch {
      resultBytes = Number.POSITIVE_INFINITY;
    }
    if (bytes + resultBytes + (boundedResults.length ? 1 : 0) > 6_000) {
      break;
    }
    boundedResults.push(result);
    bytes += resultBytes + (boundedResults.length > 1 ? 1 : 0);
  }
  return {
    failedIndex,
    failedAction,
    completedActions: failedIndex,
    completedResults: boundedResults,
    ...(boundedResults.length < completedResults.length ? { resultsTruncated: true, omittedResults: completedResults.length - boundedResults.length } : {}),
    batch: {
      failedIndex,
      failedAction,
      completedActions: failedIndex,
    },
  };
}

function boundedSnapshotError(error: unknown): { code: string; message: string; retryable: boolean } {
  const normalized = asAppError(error);
  return {
    code: normalized.code.slice(0, 200),
    message: normalized.message.slice(0, 1_000),
    retryable: normalized.retryable,
  };
}

function isPageClosed(page: Page): boolean {
  try {
    return page.isClosed();
  } catch {
    return true;
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const file = await lstat(path);
    if (file.isSymbolicLink()) {
      throw new AppError("FILE_PATH_BLOCKED", "The output path must not be a symbolic link.");
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isMissingFile(error)) {
      throw error;
    }
  });
}

function trimLog(entries: LogEntry[]): void {
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
}

function untrustedLogEntries(entries: LogEntry[]): LogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.text ? { text: wrapUntrustedText("browser_log", redactSecretPlaceholders(entry.text), 2_000) } : {}),
    ...(entry.url ? { untrustedUrl: wrapUntrustedText("browser_log_url", redactSecretPlaceholders(entry.url), 4_096) } : {}),
  }));
}

function sanitizeStorageResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const result = { ...(value as Record<string, unknown>) };
  if (typeof result.key === "string") {
    result.key = wrapUntrustedText("storage_key", redactSecretPlaceholders(result.key), 1_000);
  }
  if (Array.isArray(result.keys)) {
    result.keys = result.keys
      .filter((key): key is string => typeof key === "string")
      .slice(0, 200)
      .map((key) => wrapUntrustedText("storage_key", redactSecretPlaceholders(key), 1_000));
  }
  if (typeof result.value === "string") {
    result.value = wrapUntrustedText("storage_value", redactSecretPlaceholders(result.value), 20_000);
  }
  if (result.values && typeof result.values === "object" && !Array.isArray(result.values)) {
    const sourceValues = result.values as Record<string, unknown>;
    const sourceCount = Object.keys(sourceValues).length;
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    let totalChars = 0;
    for (const [key, rawValue] of Object.entries(sourceValues)) {
      if (typeof rawValue !== "string" || totalChars >= 100_000) {
        continue;
      }
      const bounded = rawValue.slice(0, Math.min(20_000, 100_000 - totalChars));
      totalChars += bounded.length;
      const safeKey = wrapUntrustedText("storage_key", redactSecretPlaceholders(key), 1_000);
      values[safeKey] = wrapUntrustedText("storage_value", redactSecretPlaceholders(bounded), 20_000);
    }
    result.values = values;
    result.truncated = result.truncated === true || Object.keys(values).length < sourceCount || totalChars >= 100_000;
  }
  return result;
}

function sanitizeEvaluateResult(value: unknown): unknown {
  const redacted = redactValue(value);
  if (typeof value === "string") {
    return wrapUntrustedText("evaluate_result", redactSecretPlaceholders(String(redacted)), 20_000);
  }
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    const record = { ...(redacted as Record<string, unknown>) };
    const metadataKey = Object.hasOwn(record, "untrustedSource") ? "__untrustedSource" : "untrustedSource";
    record[metadataKey] = "page";
    return record;
  }
  return { value: redacted, untrustedSource: "page" };
}

function boundAccessibilityNodes<T>(nodes: T[], maxChars: number): { nodes: T[]; truncated: boolean } {
  const limit = Number.isFinite(maxChars) ? Math.max(2, Math.floor(maxChars)) : 2;
  const bounded: T[] = [];
  let serializedLength = 2; // []
  for (const node of nodes) {
    const serializedNode = JSON.stringify(node);
    if (serializedNode === undefined) {
      continue;
    }
    const nextLength = bounded.length === 0
      ? 2 + serializedNode.length
      : serializedLength + 1 + serializedNode.length;
    if (nextLength > limit) {
      break;
    }
    bounded.push(node);
    serializedLength = nextLength;
  }
  return { nodes: bounded, truncated: bounded.length < nodes.length };
}

function targetForAction(action: BrowserAction, field: string): string {
  const target = action.target ?? action.ref ?? action.selector;
  if (target) {
    return target;
  }
  if (action.index !== undefined) {
    return `e${action.index + 1}`;
  }
  throw new AppError("INVALID_ACTION", `The '${field}' field is required.`);
}

function elementReferenceForAction(action: BrowserAction): string | undefined {
  const target = action.ref ?? action.target ?? (action.index !== undefined ? `e${action.index + 1}` : undefined);
  return target && isElementReference(target) ? target : undefined;
}

function requirePresentField<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw new AppError("INVALID_ACTION", `The '${field}' field is required.`);
  }
  return value;
}

function isElementReference(target: string): boolean {
  const normalized = target.trim().replace(/^ref:/, "");
  return /^e\d+$/.test(normalized);
}

function tabIdentifier(pageId: string, states: Map<string, PageState>): string {
  const shortId = pageId.slice(-4);
  const collision = [...states.keys()].some((candidate) => candidate !== pageId && candidate.endsWith(shortId));
  return collision ? pageId : shortId;
}

function isDialogAction(action: BrowserAction): boolean {
  return action.action === "alert_get_text" || action.action === "alert_accept" || action.action === "alert_dismiss" || action.action === "alert_send_keys";
}

function shouldPropagateTargetError(error: unknown): boolean {
  return error instanceof AppError && ["STALE_REFERENCE", "FRAME_MISMATCH", "FRAME_NOT_FOUND"].includes(error.code);
}

function isSelectorSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:failed to execute ['"]?queryselector|not a valid selector|syntaxerror.*selector|invalid selector)/i.test(message);
}

function isNoHistoryNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /history (?:entry|item).*not found|no history entry/i.test(message);
}

function isChallengeAbsent(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && (value as { status?: unknown }).status === "absent");
}

function isChallengeUnknown(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && (value as { status?: unknown }).status === "unknown");
}

function isChallengeBlockedAction(action: BrowserAction["action"]): boolean {
  return CHALLENGE_BLOCKED_ACTIONS.has(action);
}

function safeOrigin(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.origin === "null" ? "" : url.origin;
  } catch {
    return "";
  }
}

function framePath(frame: Frame): string {
  if (!frame.parentFrame()) {
    return "main";
  }
  const existing = FRAME_IDS.get(frame);
  if (existing) {
    return existing;
  }
  const identifier = `frame-${randomUUID().slice(0, 12)}`;
  FRAME_IDS.set(frame, identifier);
  return identifier;
}

function isFrameDetached(frame: Frame): boolean {
  try {
    return frame.isDetached();
  } catch {
    return true;
  }
}

function axValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean" ? String(nested) : "";
  }
  return "";
}

function isInterestingAxNode(node: Record<string, unknown>): boolean {
  const role = axValue(node.role).toLowerCase();
  const name = axValue(node.name);
  return Boolean(name) || ["button", "checkbox", "combobox", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "textbox"].includes(role);
}

function normalizeKeyInput(rawKey: string): KeyInput {
  const candidate = rawKey.length === 1 ? rawKey : rawKey.trim();
  return COMMON_KEY_ALIASES[candidate.toUpperCase()] ?? candidate as KeyInput;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(new AppError("BROWSER_QUEUE_TIMEOUT", `The browser operation waited more than ${timeoutMs}ms for its turn.`, { retryable: true, details: { timeoutMs } }));
    }, Math.max(1, Math.floor(timeoutMs)));
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      settle(() => reject(new AppError("CANCELLED", "The browser action was cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      settle(resolvePromise);
    }, () => {
      settle(resolvePromise);
    });
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new AppError("CANCELLED", "The browser action was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function settleWithTimeout<T>(promise: Promise<T> | undefined, timeoutMs: number): Promise<T | undefined> {
  if (!promise) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(undefined), Math.max(1, Math.floor(timeoutMs)));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function settlesWithinTimeout(promise: Promise<unknown> | undefined, timeoutMs: number): Promise<boolean> {
  if (!promise) {
    return true;
  }
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await settleWithTimeout(promise, timeoutMs).catch(() => undefined);
  return settled;
}

async function promiseSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const settledMarker = Symbol("settled");
  const result = await settleWithTimeout(promise.then(() => settledMarker, () => settledMarker), timeoutMs);
  return result === settledMarker;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(new AppError("CANCELLED", "The browser action was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function nextEventLoop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clearImmediate(immediate);
      cleanup();
      reject(new AppError("CANCELLED", "The browser action was cancelled."));
    };
    const immediate = setImmediate(() => {
      cleanup();
      resolvePromise();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseDevToolsActivePort(raw: string): string | undefined {
  const [portLine, webSocketPath] = raw.split(/\r?\n/, 3);
  if (!portLine || !webSocketPath || !/^\d{1,5}$/.test(portLine) || !/^\/[A-Za-z0-9._\-/]+$/.test(webSocketPath)) {
    return undefined;
  }
  const port = Number(portLine);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? `http://127.0.0.1:${port}` : undefined;
}

async function probeDevToolsEndpoint(browserURL: string, timeoutMs: number): Promise<DevToolsVersion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/json/version", browserURL), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`DevTools endpoint returned HTTP ${response.status}.`);
    }
    const value: unknown = await response.json();
    if (!isRecordValue(value)) {
      throw new Error("DevTools endpoint returned an invalid version payload.");
    }
    return {
      Browser: boundedEndpointField(value.Browser),
      "Protocol-Version": boundedEndpointField(value["Protocol-Version"]),
      webSocketDebuggerUrl: boundedEndpointField(value.webSocketDebuggerUrl),
    };
  } finally {
    clearTimeout(timer);
  }
}

function boundedEndpointField(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 4_096) : undefined;
}

function redactWebSocketEndpoint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).pathname.slice(0, 4_096);
  } catch {
    return "[INVALID]";
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function boundedScreenshotDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 1_000_000) : 0;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCdpSessionLike(value: unknown): value is CDPSession {
  return Boolean(value && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "function"
    && typeof (value as { send?: unknown }).send === "function"
    && typeof (value as { on?: unknown }).on === "function");
}

function parseTargetAttachedEvent(value: unknown): TargetAttachedEvent | undefined {
  if (!isRecordValue(value) || typeof value.sessionId !== "string" || !isRecordValue(value.targetInfo)
    || typeof value.targetInfo.targetId !== "string") {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    targetInfo: {
      targetId: value.targetInfo.targetId,
      ...(typeof value.targetInfo.type === "string" ? { type: value.targetInfo.type } : {}),
      ...(typeof value.targetInfo.url === "string" ? { url: value.targetInfo.url } : {}),
    },
  };
}

function isGuardableTarget(targetInfo: TargetAttachedEvent["targetInfo"]): boolean {
  return targetInfo.type === "page" || targetInfo.type === "tab" || targetInfo.type === "service_worker" || targetInfo.type === "shared_worker";
}

function isAutoAttachedTarget(connection: TargetGuardConnection, targetId: string): boolean | undefined {
  if (typeof connection.isAutoAttached !== "function") {
    return undefined;
  }
  try {
    return connection.isAutoAttached(targetId);
  } catch {
    return undefined;
  }
}

function getCdpSession(connection: TargetGuardConnection, sessionId: string): CDPSession | undefined {
  try {
    const session = connection.session?.(sessionId) ?? connection._session?.(sessionId) ?? connection._sessions?.get(sessionId);
    return isCdpSessionLike(session) ? session : undefined;
  } catch {
    return undefined;
  }
}

async function sendSessionCommand(session: CDPSession | undefined, method: string): Promise<void> {
  if (!session) {
    return;
  }
  await (session as unknown as { send(methodName: string): Promise<unknown> }).send(method);
}

function addCdpListener(session: CDPSession, event: string, listener: (event: unknown) => void): void {
  const emitter = session as unknown as { on(eventName: string, callback: (eventValue: unknown) => void): void };
  emitter.on(event, listener);
}

function removeCdpListener(session: CDPSession, event: string, listener: (event: unknown) => void): void {
  const emitter = session as unknown as { off?(eventName: string, callback: (eventValue: unknown) => void): void };
  try {
    emitter.off?.(event, listener);
  } catch {
    // A detached target may reject listener removal.
  }
}

function restoreGuardSend(guard: TargetGuardSession): void {
  if (!guard.originalSend || !guard.wrappedSend) {
    return;
  }
  const session = guard.session as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
  if (session.send === guard.wrappedSend) {
    try {
      session.send = guard.originalSend;
    } catch {
      // A frozen CDP session can retain the wrapper until it disconnects.
    }
  }
}
