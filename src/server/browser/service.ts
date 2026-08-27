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
  focusable?: boolean;
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
  viewportConfigured: boolean;
  viewportSession?: CDPSession;
  downloadConfigured: boolean;
  downloadConfigurationError?: AppError;
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
  policyVerifiedUrls: Set<string>;
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
  abandoned?: boolean;
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
// Keep a finite admission bound for hostile/unbounded clients, while leaving
// enough headroom for legitimate concurrent read bursts. The read lane still
// limits actual Chromium work separately.
const MAX_QUEUED_OPERATIONS = 1_024;
const MAX_PARALLEL_READ_OPERATIONS = 8;
// Popup observation is bounded by the enclosing action signal. This short
// post-click grace period catches targetcreated/page events that are delivered
// just after Puppeteer resolves the click without making a click with no popup
// wait for the whole action deadline.
const POPUP_POST_CLICK_SETTLE_TIMEOUT_MS = 300;
const MAX_DOM_TRAVERSAL_NODES = 20_000;
const MAX_TEXT_SCAN_CHARS = 500_000;
const MAX_MARKUP_EVIDENCE_CHARS = 120_000;
const MAX_DOWNLOAD_ENTRIES = 100;
const TARGET_GUARD_MAX_REQUEST_IDS = 128;
const CLICK_SETTLE_TIMEOUT_MS = 10;
const CLICK_RETRY_ATTEMPTS = 3;
const CLICK_RETRY_DELAY_MS = 16;
const NAVIGATION_CLICK_SETTLE_TIMEOUT_MS = 50;
const NAVIGATION_CLICK_EVENT_TIMEOUT_MS = 250;
const NAVIGATION_CLICK_READY_TIMEOUT_MS = 250;
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
  "upload_file", "evaluate", "run_script", "hover", "move", "press_and_hold",
  "set_cookie", "delete_cookies", "set_storage", "clear_storage",
]);
const SNAPSHOT_AFTER_ACTIONS = new Set<BrowserAction["action"]>([
  "navigate", "click", "input", "select_dropdown", "scroll", "send_keys", "go_back", "go_forward", "reload",
]);
const DOM_MUTATING_ACTIONS = new Set<BrowserAction["action"]>([
  "navigate", "click", "input", "select_dropdown", "scroll", "scroll_to_bottom", "send_keys", "go_back", "go_forward", "reload", "upload_file", "set_storage", "clear_storage", "find_text", "evaluate", "hover", "move", "press_and_hold", "alert_accept", "alert_dismiss", "alert_send_keys",
]);
const PARALLEL_READ_ACTIONS = new Set<BrowserAction["action"]>([
  "wait", "wait_for_element", "wait_for_text", "wait_for_url", "wait_for_network_idle",
  "get_network_log", "get_console_log", "extract", "get_html", "dropdown_options", "page_next", "search_page", "find_elements", "list_frames", "accessibility_snapshot", "get_computed_style", "get_page_info", "get_cookies", "get_storage", "list_downloads",
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
  private readonly activeOperationControllers = new Set<AbortController>();
  private activeReadOperations = 0;
  private readonly readPermitWaiters: Array<() => void> = [];
  private readDrainPromise = Promise.resolve();
  private readDrainRelease: (() => void) | undefined;
  private currentPageId: string | undefined;
  private sessionGeneration = 0;
  private readonly states = new Map<string, PageState>();
  private readonly configuredDownloadContexts = new WeakSet<object>();
  private readonly ids = new WeakMap<Page, string>();
  private readonly targetGuardSessions = new Map<string, TargetGuardSession>();
  private readonly targetGuardNavigationErrors = new Map<string, AppError>();
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
    for (const controller of this.activeOperationControllers) {
      controller.abort();
    }
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
    for (const controller of this.activeOperationControllers) {
      controller.abort();
    }
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
        await this.assertCurrentPageAllowed(page, state);
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
    await this.assertCurrentPageAllowed(state.page, state);
    const frame = await this.frameFor(state, options.frameId);
    const domRevisionAtStart = state.domRevision;
    const maxChars = Math.min(options.maxChars ?? 40_000, this.config.browser.maxHtmlChars);
    const result: SnapshotEvaluation = await frame.evaluate(({ limit, maxNodes }) => {
      type StackEntry = { element: Element; hidden: boolean };
      const hiddenTags = new Set(["script", "style", "noscript", "template"]);
      const interactiveTags = new Set(["a", "button", "input", "select", "textarea", "summary"]);
      const uniqueIds = new Set<string>();
      const duplicateIds = new Set<string>();
      const visibleInteractive: Element[] = [];
      const headings: string[] = [];
      let visibleInteractiveCount = 0;
      let visitedNodes = 0;
      let traversalTruncated = false;
      let idScanComplete = true;

      const boundedText = (root: Node | null, textLimit: number, nodeLimit = 2_000): { text: string; truncated: boolean } => {
        if (!root || textLimit <= 0) {
          return { text: "", truncated: Boolean(root) && textLimit <= 0 };
        }
        const stack: Array<{ node: Node; hidden: boolean }> = [{ node: root, hidden: false }];
        const output: string[] = [];
        let length = 0;
        let visited = 0;
        let truncated = false;
        while (stack.length > 0) {
          const current = stack.pop();
          if (!current) {
            break;
          }
          visited += 1;
          if (visited > nodeLimit) {
            truncated = true;
            break;
          }
          if (current.node.nodeType === 3) {
            if (current.hidden) {
              continue;
            }
            const raw = current.node.nodeValue ?? "";
            const remaining = textLimit - length;
            if (remaining <= 0) {
              truncated = true;
              break;
            }
            const part = raw.slice(0, remaining);
            output.push(part);
            length += part.length;
            if (part.length < raw.length) {
              truncated = true;
              break;
            }
            continue;
          }
          if (current.node.nodeType !== 1) {
            continue;
          }
          const element = current.node as Element;
          const tag = element.tagName.toLowerCase();
          if (hiddenTags.has(tag)) {
            continue;
          }
          const style = element.getAttribute("style") ?? "";
          const locallyHidden = current.hidden
            || element.hasAttribute("hidden")
            || element.getAttribute("aria-hidden") === "true"
            || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
          const children = element.childNodes;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) {
              stack.push({ node: child, hidden: locallyHidden });
            }
          }
        }
        return { text: output.join(""), truncated };
      };

      const isInteractive = (element: Element): boolean => {
        const tag = element.tagName.toLowerCase();
        return interactiveTags.has(tag)
          || element.hasAttribute("role")
          || element.hasAttribute("onclick")
          || element.hasAttribute("tabindex")
          || (tag === "label" && element.hasAttribute("for"))
          || element.getAttribute("contenteditable") === "true";
      };

      const isVisible = (element: Element, hidden: boolean): boolean => {
        if (hidden) {
          return false;
        }
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && style.visibility !== "hidden"
          && style.display !== "none"
          && Number.parseFloat(style.opacity || "1") > 0
          && style.pointerEvents !== "none";
      };

      const root = document.body;
      const stack: StackEntry[] = root ? [{ element: root, hidden: false }] : [];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          break;
        }
        visitedNodes += 1;
        if (visitedNodes > maxNodes) {
          traversalTruncated = true;
          idScanComplete = false;
          break;
        }
        const { element, hidden } = current;
        const tag = element.tagName.toLowerCase();
        if (hiddenTags.has(tag)) {
          continue;
        }
        const style = element.getAttribute("style") ?? "";
        const locallyHidden = hidden
          || element.hasAttribute("hidden")
          || element.getAttribute("aria-hidden") === "true"
          || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
        const id = element.getAttribute("id") ?? "";
        if (id) {
          if (uniqueIds.has(id)) {
            uniqueIds.delete(id);
            duplicateIds.add(id);
          } else if (!duplicateIds.has(id)) {
            uniqueIds.add(id);
          }
        }
        if (!locallyHidden && isInteractive(element) && isVisible(element, locallyHidden)) {
          visibleInteractiveCount += 1;
          if (visibleInteractive.length < 250) {
            visibleInteractive.push(element);
          }
        }
        if (/^h[1-6]$/.test(tag) && !locallyHidden && headings.length < 100) {
          const headingText = boundedText(element, 500, 256).text.trim();
          if (headingText) {
            headings.push(headingText);
          }
        }
        const children = element.children;
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child) {
            stack.push({ element: child, hidden: locallyHidden });
          }
        }
      }
      if (traversalTruncated) {
        idScanComplete = false;
      }

      const interactive = visibleInteractive.map((element, index) => {
        const htmlElement = element as HTMLElement & { disabled?: boolean; type?: string };
        const rect = htmlElement.getBoundingClientRect();
        let selector = "body";
        if (idScanComplete && htmlElement.id && htmlElement.id.length <= 500 && uniqueIds.has(htmlElement.id) && !duplicateIds.has(htmlElement.id)) {
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
            let siblingIndex = 0;
            let currentIndex = 0;
            for (let childIndex = 0; childIndex < parent.children.length; childIndex += 1) {
              const child = parent.children[childIndex];
              if (!child) {
                continue;
              }
              if (child.tagName === currentTagName) {
                siblingIndex += 1;
                if (child === current) {
                  currentIndex = siblingIndex;
                }
              }
            }
            parts.unshift(`${tag}:nth-of-type(${currentIndex || 1})`);
            current = parent;
          }
          selector = parts.join(" > ") || "body";
        }
        const anchor = element.closest("a") as HTMLAnchorElement | null;
        const boundedElementText = boundedText(element, 500, 512).text.replace(/\s+/g, " ").trim().slice(0, 500);
        // Geometry is deliberately excluded: sticky headers, lazy ads, and
        // scrolling can move the same DOM node between snapshot and action.
        const signature = [
          element.tagName.toLowerCase(),
          (element.getAttribute("id") ?? "").slice(0, 500),
          (element.getAttribute("name") ?? "").slice(0, 500),
          (element.getAttribute("role") ?? "").slice(0, 500),
          (element.getAttribute("aria-label") ?? "").slice(0, 500),
          (element.getAttribute("placeholder") ?? "").slice(0, 500),
          element.getAttribute("disabled") ?? "",
          element.getAttribute("aria-disabled") ?? "",
          String(htmlElement.type ?? "").slice(0, 100),
          boundedElementText,
          (anchor?.href ?? "").slice(0, 4_096),
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
            : boundedElementText,
          ariaLabel: element.getAttribute("aria-label")?.slice(0, 500) ?? undefined,
          type: htmlElement.type?.slice(0, 100) ?? undefined,
          valuePresent: /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) && "value" in htmlElement && String((htmlElement as HTMLInputElement).value ?? "").length > 0,
          disabled: Boolean(htmlElement.disabled || element.getAttribute("aria-disabled") === "true"),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      });
      const textResult = boundedText(root, limit, maxNodes);
      return {
        text: textResult.text,
        textTruncated: textResult.truncated,
        headings,
        interactive,
        interactiveTruncated: traversalTruncated || visibleInteractiveCount > visibleInteractive.length,
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
    }, { limit: Math.max(0, maxChars), maxNodes: MAX_DOM_TRAVERSAL_NODES });
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
        const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), Math.max(1, Math.floor(timeoutMs)));
        try {
          return await this.executeDialogAction(pendingState, action, combineSignals(signal, this.shutdownController.signal, timeoutController.signal));
        } catch (error) {
          if (timeoutController.signal.aborted && !signal?.aborted && !this.shutdownController.signal.aborted) {
            throw new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(timeoutMs))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(timeoutMs)) }, cause: error });
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          // Resolving a dialog can run page JavaScript (for example a confirm
          // handler can replace the form). Invalidate refs even when the
          // caller cancels while Chromium is settling the dialog command.
          if (action.action !== "alert_get_text") {
            this.invalidateActionSnapshot(action, { pageId: pendingState.id });
          }
        }
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
      let result: unknown;
      let snapshotInvalidated = false;
      try {
        result = await this.executeUnlocked(action, operationSignal);
        if (DOM_MUTATING_ACTIONS.has(action.action)) {
          this.invalidateActionSnapshot(action, result);
          snapshotInvalidated = true;
        }
        if (!action.includeSnapshot || !SNAPSHOT_AFTER_ACTIONS.has(action.action)) {
          return result;
        }
        return this.attachOptionalSnapshot(action, result, operationSignal);
      } finally {
        // A browser action can mutate the document and then be cancelled while
        // Puppeteer is still settling. Do not leave refs from the pre-action
        // document usable in that window. A successful action has already
        // invalidated before its optional trailing snapshot is collected.
        if (DOM_MUTATING_ACTIONS.has(action.action) && !snapshotInvalidated) {
          this.invalidateActionSnapshot(action, result);
        }
      }
    }, budgetMs, budgetMs, PARALLEL_READ_ACTIONS.has(action.action) && action.includeSnapshot !== true ? "read" : "exclusive");
  }

  private invalidateActionSnapshot(action: BrowserAction, result: unknown): void {
    const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
    const resultPageId = typeof record?.pageId === "string"
      ? record.pageId
      : typeof record?.openedPageId === "string"
        ? record.openedPageId
        : action.pageId ?? this.currentPageId;
    let state = resultPageId ? this.states.get(resultPageId) : undefined;
    if (!state && action.pageId) {
      try {
        const resolvedPageId = this.resolvePageId(action.pageId);
        state = resolvedPageId ? this.states.get(resolvedPageId) : undefined;
      } catch {
        // Invalidation is best-effort cleanup. An ambiguous alias must not
        // turn the original browser error into a different failure.
      }
    }
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
    if (isDialogAction(action)) {
      const pendingState = this.dialogState(action.pageId);
      if (pendingState?.dialogs.length) {
        return this.executeDialogAction(pendingState, action, signal);
      }
    }

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
      this.clearTargetGuardNavigationError(state.page);
      const navigationGeneration = this.beginNavigation(state);
      try {
        await state.page.goto(url.toString(), { waitUntil: action.waitUntil ?? "domcontentloaded", timeout: action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal });
        this.throwNavigationError(state, navigationGeneration);
        await this.assertCurrentPageAllowed(state.page, state);
      } catch (error) {
        const navigationError = this.takeNavigationError(state, navigationGeneration) ?? this.takeTargetGuardNavigationError(state.page);
        if (newTab) {
          await this.disposePageState(state);
        }
        if (navigationError) {
          if (!newTab) {
            await this.recoverBlockedNavigation(state);
          }
          throw navigationError;
        }
        const currentUrl = state.page.url();
        if (!newTab && !/^https?:\/\//i.test(currentUrl)) {
          await this.recoverBlockedNavigation(state);
          throw new AppError("NAVIGATION_BLOCKED", "The browser navigation was blocked by policy.", { retryable: true, cause: error });
        }
        throw error;
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
    await this.assertCurrentPageAllowed(page, state);
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
        const pointerType = action.pointerType ?? "mouse";
        if (pointerType === "touch" && (action.button ?? "left") !== "left") {
          throw new AppError("INVALID_ACTION", "Touch clicks support only the left button.");
        }
        if (pointerType === "touch" && (action.clickCount ?? 1) !== 1) {
          throw new AppError("INVALID_ACTION", "Touch clicks support one tap at a time.");
        }
        if (coordinateX !== undefined || coordinateY !== undefined) {
          if (coordinateX === undefined || coordinateY === undefined) {
            throw new AppError("INVALID_ACTION", "coordinateX and coordinateY must be provided together.");
          }
          if (action.frameId && action.frameId !== "main") {
            throw new AppError("FRAME_ACTION_UNSUPPORTED", "Coordinate clicks target the top-level viewport; use a selector or ref for a child frame.");
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
            const anchor = clickable.closest("a") as HTMLAnchorElement | null;
            const boundedText = (root: Node): string => {
              const stack: Node[] = [root];
              let output = "";
              let visited = 0;
              while (stack.length > 0 && output.length < 200) {
                const node = stack.pop();
                if (!node) break;
                visited += 1;
                if (visited > 512) break;
                if (node.nodeType === 3) {
                  output += (node.nodeValue ?? "").slice(0, 200 - output.length);
                  continue;
                }
                if (node.nodeType !== 1) continue;
                const element = node as Element;
                if (["script", "style", "noscript", "template"].includes(element.tagName.toLowerCase())) continue;
                const children = element.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) stack.push(child);
                }
              }
              return output;
            };
            return {
              tag: clickable.tagName.toLowerCase(),
              type: htmlElement.type?.toLowerCase() ?? "",
              role: clickable.getAttribute("role") ?? "",
              label: [boundedText(clickable), clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
              href: anchor?.href ?? clickable.getAttribute("href") ?? undefined,
            };
          }, { x: coordinateX, y: coordinateY });
          if (coordinateTarget) {
            this.assertClickTargetSafe(coordinateTarget);
            if (coordinateTarget.href) {
              await this.assertNavigationUrl(page.url(), coordinateTarget.href);
            }
          }
          monitor = await this.runClickAndMonitor(page, () => pointerType === "touch"
            ? this.touchTap(page, coordinateX, coordinateY, signal)
            : this.mouseClick(page, coordinateX, coordinateY, action.button ?? "left", action.clickCount ?? 1, signal), signal, Boolean(coordinateTarget?.href));
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
          monitor = await this.clickTarget(state, target, action.button ?? "left", action.clickCount ?? 1, signal, frame, pointerType);
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
        const selector = await this.selectorFor(state, targetForAction(action, "target"), action.frameId, frame);
        const values = action.optionValues ?? (action.optionValue !== undefined || action.value !== undefined
          ? [requireField(action.optionValue ?? action.value, "optionValue")]
          : []);
        if (values.length === 0) {
          throw new AppError("INVALID_ACTION", "Select requires optionValue or optionValues.");
        }
        let selected: string[];
        try {
          selected = await frame.select(selector, ...values);
        } catch (error) {
          if (isMissingElementError(error)) {
            throw new AppError("ELEMENT_NOT_FOUND", `No select element matched '${selector.slice(0, 200)}'.`, { cause: error });
          }
          if (isInvalidSelectorError(error)) {
            throw new AppError("INVALID_SELECTOR", `The selector '${selector.slice(0, 200)}' is invalid.`, { cause: error });
          }
          throw normalizeBrowserOperationError(error, signal);
        }
        return { selected, pageId: state.id };
      }
      case "scroll": {
        const amount = action.amount ?? 600;
        const directionName = action.direction ?? "down";
        const direction = directionName === "up" || directionName === "left" ? -1 : 1;
        const delta = { x: directionName === "left" || directionName === "right" ? amount * direction : 0, y: directionName === "up" || directionName === "down" ? amount * direction : 0 };
        if (action.selector) {
          const selector = await this.selectorFor(state, action.selector, action.frameId, frame);
          const scrollResult = await frame.$eval(selector, (element, { x, y: deltaY }) => {
            let container: HTMLElement | null = element instanceof HTMLElement ? element : element.parentElement;
            while (container && container !== document.body) {
              const style = window.getComputedStyle(container);
              const scrollable = (container.scrollHeight > container.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY))
                || (container.scrollWidth > container.clientWidth + 1 && /auto|scroll|overlay/.test(style.overflowX));
              if (scrollable) break;
              container = container.parentElement;
            }
            if (!container || container === document.body) {
              window.scrollBy({ left: x, top: deltaY, behavior: "instant" as ScrollBehavior });
              return { x: window.scrollX, y: window.scrollY, container: "document" as const };
            }
            const maxX = Math.max(0, container.scrollWidth - container.clientWidth);
            const maxY = Math.max(0, container.scrollHeight - container.clientHeight);
            container.scrollLeft = Math.max(0, Math.min(maxX, container.scrollLeft + x));
            container.scrollTop = Math.max(0, Math.min(maxY, container.scrollTop + deltaY));
            container.dispatchEvent(new Event("scroll", { bubbles: true }));
            return { x: container.scrollLeft, y: container.scrollTop, container: "element" as const };
          }, delta);
          return { scrolled: true, ...scrollResult, frameId: framePath(frame), selector };
        }
        const scrollResult = await frame.evaluate(({ x, y: deltaY }) => {
          // MiniWoB++ uses focused textareas and nested overflow containers
          // whose scroll position is independent of the document. Prefer the
          // nearest scrollable ancestor of the focused control, while keeping
          // ordinary page scrolling on window for all other pages.
          let container: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          while (container && container !== document.body) {
            const style = window.getComputedStyle(container);
            const scrollable = (container.scrollHeight > container.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY))
              || (container.scrollWidth > container.clientWidth + 1 && /auto|scroll|overlay/.test(style.overflowX));
            if (scrollable) break;
            container = container.parentElement;
          }
          if (container && container !== document.body) {
            const maxX = Math.max(0, container.scrollWidth - container.clientWidth);
            const maxY = Math.max(0, container.scrollHeight - container.clientHeight);
            container.scrollLeft = Math.max(0, Math.min(maxX, container.scrollLeft + x));
            container.scrollTop = Math.max(0, Math.min(maxY, container.scrollTop + deltaY));
            container.dispatchEvent(new Event("scroll", { bubbles: true }));
            return { x: container.scrollLeft, y: container.scrollTop, container: "element" as const };
          }
          window.scrollBy({ left: x, top: deltaY, behavior: "instant" as ScrollBehavior });
          return { x: window.scrollX, y: window.scrollY, container: "document" as const };
        }, delta);
        return { scrolled: true, ...scrollResult, frameId: framePath(frame) };
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
        try {
          for (; iterations < maxScrolls; iterations += 1) {
            throwIfAborted(signal);
            if (scrollDeadline - Date.now() <= 0) {
              throw new AppError("WAIT_TIMEOUT", "Scroll-to-bottom exceeded its action timeout.", { retryable: true, details: { phase: "wait", timeoutMs: action.timeoutMs ?? this.config.browser.actionTimeoutMs } });
            }
            const before = await page.evaluate(() => {
              const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
              return { height, y: window.scrollY, viewport: window.innerHeight };
            });
            const targetY = Math.max(0, before.height - before.viewport);
            await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), targetY);
            const remaining = scrollDeadline - Date.now();
            if (remaining <= 0) {
              throw new AppError("WAIT_TIMEOUT", "Scroll-to-bottom exceeded its action timeout.", { retryable: true, details: { phase: "wait", timeoutMs: action.timeoutMs ?? this.config.browser.actionTimeoutMs } });
            }
            // Lazy content only needs a short quiet window here. A 500ms
            // fixed settle cost per iteration dominates small MiniWoB++
            // pages, while the bounded loop still observes height changes.
            await page.waitForNetworkIdle({ idleTime: 100, timeout: Math.min(remaining, 5_000), signal }).catch((error: unknown) => {
              throwIfAborted(signal);
              if (!isPuppeteerTimeoutError(error)) {
                throw normalizeBrowserOperationError(error, signal);
              }
              return undefined;
            });
            const after = await page.evaluate(() => {
              const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
              return { height, y: window.scrollY, viewport: window.innerHeight };
            });
            if (after.y + after.viewport >= after.height - 2 && after.height === before.height && after.height === previousHeight) {
              return { scrolled: true, atBottom: true, iterations: iterations + 1, height: after.height, scrollY: after.y, restored: action.restoreTop === true };
            }
            previousHeight = after.height;
          }
          const final = await page.evaluate(() => {
            const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
            return { height, y: window.scrollY, viewport: window.innerHeight };
          });
          return { scrolled: true, atBottom: final.y + final.viewport >= final.height - 2, iterations, height: final.height, scrollY: final.y, restored: action.restoreTop === true };
        } finally {
          if (action.restoreTop) {
            await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior }), initialPosition).catch(() => undefined);
          }
        }
      }
      case "send_keys":
        await this.sendKeys(page, action.keys ?? [requireField(action.key, "key")], signal);
        return { sent: true };
      case "switch_tab": {
        const targetId = requireField(action.pageId ?? action.target, "pageId");
        const targetState = await this.pageState(targetId, signal);
        await targetState.page.bringToFront();
        this.assertStateLive(targetState);
        this.currentPageId = targetState.id;
        return { pageId: targetState.id };
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
              const navigationError = this.takeNavigationError(state, navigationGeneration) ?? this.takeTargetGuardNavigationError(page);
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
          await this.assertCurrentPageAllowed(page, state);
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
              const navigationError = this.takeNavigationError(state, navigationGeneration) ?? this.takeTargetGuardNavigationError(page);
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
          await this.assertCurrentPageAllowed(page, state);
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
          throw this.takeNavigationError(state, navigationGeneration) ?? this.takeTargetGuardNavigationError(page) ?? error;
        } finally {
          if (state.activeNavigationGeneration === navigationGeneration) {
            state.activeNavigationGeneration = undefined;
          }
        }
        await this.assertCurrentPageAllowed(page, state);
        return { url: safeUrl(page.url()), title: wrapUntrustedText("page_title", redactSecretPlaceholders((await page.title().catch(() => "")).slice(0, 1_000)), 1_000) };
        }
      case "wait":
        await wait(action.milliseconds ?? 500, signal);
        return { waitedMs: action.milliseconds ?? 500 };
      case "wait_for_element": {
        const selector = targetForAction(action, "selector");
        const resolvedSelector = await this.selectorFor(state, selector, action.frameId, frame);
        const waitState = action.state ?? "visible";
        await waitForElementState(frame, resolvedSelector, waitState, action.timeoutMs ?? this.config.browser.actionTimeoutMs, signal);
        return { found: true, selector, state: waitState };
      }
      case "wait_for_text": {
        const text = requireField(action.text ?? action.query, "text");
        const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
        try {
          await frame.waitForFunction((needle, maxNodes) => {
            const target = needle.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
            if (!target || !document.body) return false;
            const hiddenTags = new Set(["script", "style", "noscript", "template"]);
            const stack: Array<{ node: Node; hidden: boolean }> = [{ node: document.body, hidden: false }];
            let visited = 0;
            let rolling = "";
            while (stack.length > 0) {
              const entry = stack.pop();
              if (!entry) break;
              visited += 1;
              if (visited > maxNodes) return false;
              if (entry.node.nodeType === 3) {
                if (entry.hidden) continue;
                const normalized = (entry.node.nodeValue ?? "").normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
                const combined = `${rolling}${normalized}`;
                if (normalized.includes(target) || combined.includes(target)) return true;
                rolling = combined.slice(-Math.max(1_024, target.length * 2));
                continue;
              }
              if (entry.node.nodeType !== 1) continue;
              const element = entry.node as Element;
              const tag = element.tagName.toLowerCase();
              if (hiddenTags.has(tag)) continue;
              const style = element.getAttribute("style") ?? "";
              const locallyHidden = entry.hidden
                || element.hasAttribute("hidden")
                || element.getAttribute("aria-hidden") === "true"
                || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
              const children = element.childNodes;
              for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (child) stack.push({ node: child, hidden: locallyHidden });
              }
            }
            return false;
          }, { timeout: timeoutMs, signal }, text, MAX_DOM_TRAVERSAL_NODES);
        } catch (error) {
          if (isPuppeteerTimeoutError(error)) {
            throw new AppError("WAIT_TIMEOUT", `The text '${text.slice(0, 200)}' did not appear within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs } });
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
        {
          const timeoutMs = action.timeoutMs ?? this.config.browser.actionTimeoutMs;
          try {
            await page.waitForNetworkIdle({ idleTime: 500, timeout: timeoutMs, signal });
          } catch (error) {
            if (isPuppeteerTimeoutError(error)) {
              throw new AppError("WAIT_TIMEOUT", `The page did not become network-idle within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs }, cause: error });
            }
            throw error;
          }
        }
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
        const match = await frame.evaluate((needle, maxNodes) => {
          const target = needle.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
          if (!target) return undefined;
          const hiddenTags = new Set(["script", "style", "noscript", "template"]);
          const readText = (root: Element | null): string => {
            if (!root) return "";
            const maybeChildNodes = (root as unknown as { childNodes?: unknown }).childNodes;
            if (!maybeChildNodes) return String((root as unknown as { textContent?: unknown }).textContent ?? "").slice(0, 1_000);
            const stack: Node[] = [root];
            let output = "";
            let visited = 0;
            while (stack.length > 0 && output.length < 1_000) {
              const node = stack.pop();
              if (!node) break;
              visited += 1;
              if (visited > 512) break;
              if (node.nodeType === 3) {
                output += (node.nodeValue ?? "").slice(0, 1_000 - output.length);
                continue;
              }
              if (node.nodeType !== 1) continue;
              const children = (node as Element).childNodes;
              for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (child) stack.push(child);
              }
            }
            return output.slice(0, 1_000);
          };
          const stack: Array<{ node: Node; hidden: boolean }> = document.body
            ? [{ node: document.body, hidden: false }]
            : [];
          let visited = 0;
          let rolling = "";
          let rollingElement: Element | null = null;
          while (stack.length > 0) {
            const entry = stack.pop();
            if (!entry) break;
            visited += 1;
            if (visited > maxNodes) break;
            const { node, hidden } = entry;
            if (node.nodeType === 3) {
              if (hidden) continue;
              const raw = node.nodeValue ?? "";
              const normalized = raw.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
              const parent = node.parentElement;
              const directMatch = normalized.includes(target);
              const combined = `${rolling}${normalized}`;
              const spanningMatch = combined.includes(target);
              if (directMatch || spanningMatch) {
                const element = directMatch ? parent : rollingElement ?? parent;
                if (element) {
                  element.scrollIntoView?.({ block: "center" });
                  return { tag: element.tagName.toLowerCase(), text: readText(element).trim() };
                }
              }
              const keep = Math.max(1_024, target.length * 2);
              rolling = combined.slice(-keep);
              rollingElement = parent;
              continue;
            }
            if (node.nodeType !== 1) continue;
            const element = node as Element;
            const tag = element.tagName.toLowerCase();
            if (hiddenTags.has(tag)) continue;
            const style = element.getAttribute("style") ?? "";
            const locallyHidden = hidden
              || element.hasAttribute("hidden")
              || element.getAttribute("aria-hidden") === "true"
              || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
            const children = element.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push({ node: child, hidden: locallyHidden });
            }
          }
          return undefined;
        }, text, MAX_DOM_TRAVERSAL_NODES);
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
        const resolvedSelector = selector ? await this.selectorFor(state, selector, action.frameId, frame) : undefined;
        const includeLinks = action.includeLinks === true;
        const extracted = (resolvedSelector
          ? await frame.$eval(resolvedSelector, (element, options: { start: number; limit: number; includeLinks: boolean; maxNodes: number }) => {
            const hiddenTags = new Set(["script", "style", "noscript", "template"]);
            const boundedText = (root: Node | null): { value: string; totalLength: number; truncated: boolean } => {
              if (!root) {
                return { value: "", totalLength: 0, truncated: false };
              }
              // Test adapters and older DOM shims may expose textContent but
              // not childNodes. Keep that compatibility path bounded too;
              // real browser pages use the incremental walker below.
              if (!("childNodes" in root)) {
                const raw = String((root as Element).textContent ?? "");
                const value = raw.slice(options.start, options.start + options.limit);
                return { value, totalLength: raw.length, truncated: options.start + value.length < raw.length };
              }
              const stack: Node[] = [root];
              let visited = 0;
              let totalLength = 0;
              let value = "";
              let truncated = false;
              while (stack.length > 0) {
                const node = stack.pop();
                if (!node) {
                  break;
                }
                visited += 1;
                if (visited > options.maxNodes) {
                  truncated = true;
                  break;
                }
                if (node.nodeType === 3) {
                  const raw = node.nodeValue ?? "";
                  const nodeEnd = totalLength + raw.length;
                  if (value.length < options.limit && nodeEnd > options.start) {
                    const startInNode = Math.max(0, options.start - totalLength);
                    value += raw.slice(startInNode, startInNode + options.limit - value.length);
                  }
                  totalLength = nodeEnd;
                  if (value.length >= options.limit && nodeEnd > options.start + options.limit) {
                    truncated = true;
                    break;
                  }
                  continue;
                }
                if (node.nodeType !== 1) {
                  continue;
                }
                const childElement = node as Element;
                if (hiddenTags.has(childElement.tagName.toLowerCase())) {
                  continue;
                }
                const children = childElement.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) {
                    stack.push(child);
                  }
                }
              }
              return { value, totalLength, truncated: truncated || options.start + value.length < totalLength };
            };
            const boundedElementText = (root: Node): string => boundedText(root).value.slice(0, 500);
            const collectLinks = (root: Node): Array<{ text: string; href: string }> => {
              const links: Array<{ text: string; href: string }> = [];
              if (!("childNodes" in root)) {
                const fallback = (root as Element).querySelectorAll?.("a") ?? [];
                for (const candidate of Array.from(fallback).slice(0, 100)) {
                  const rawHref = (candidate as HTMLAnchorElement).href || candidate.getAttribute("href") || "";
                  try {
                    const url = new URL(rawHref);
                    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                    url.username = "";
                    url.password = "";
                    links.push({ text: String(candidate.textContent ?? "").trim().slice(0, 500), href: url.toString() });
                  } catch {
                    // Ignore malformed or non-HTTP links.
                  }
                }
                return links;
              }
              const stack: Node[] = [root];
              let visited = 0;
              while (stack.length > 0 && links.length < 100) {
                const node = stack.pop();
                if (!node) break;
                visited += 1;
                if (visited > options.maxNodes) break;
                if (node.nodeType !== 1) continue;
                const candidate = node as Element;
                if (candidate.tagName.toLowerCase() === "a") {
                  const anchor = candidate as HTMLAnchorElement;
                  const rawHref = anchor.href || candidate.getAttribute("href") || "";
                  try {
                    const url = new URL(rawHref);
                    if (url.protocol === "http:" || url.protocol === "https:") {
                      url.username = "";
                      url.password = "";
                      links.push({ text: boundedElementText(candidate).trim(), href: url.toString() });
                    }
                  } catch {
                    // Ignore malformed or non-HTTP links.
                  }
                }
                const children = candidate.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) stack.push(child);
                }
              }
              return links;
            };
            const slice = boundedText(element);
            const tagName = element.tagName.toLowerCase();
            const inputType = tagName === "input" ? String((element as HTMLInputElement).type ?? "text").toLowerCase() : "";
            const formValue = tagName === "textarea" || tagName === "select"
              || (tagName === "input" && !["password", "hidden", "file"].includes(inputType))
              ? String((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value ?? "").slice(0, options.limit)
              : undefined;
            const links = options.includeLinks ? collectLinks(element) : undefined;
            return { value: slice.value, formValue, totalLength: slice.totalLength, truncated: slice.truncated, links };
          }, { start: offset, limit: maxChars, includeLinks, maxNodes: MAX_DOM_TRAVERSAL_NODES }).catch((error: unknown) => {
            if (isMissingElementError(error)) {
              throw new AppError("ELEMENT_NOT_FOUND", `No element matched '${resolvedSelector}'.`, { cause: error });
            }
            throw normalizeBrowserOperationError(error, signal);
          })
          : await frame.evaluate(({ start, limit, includeLinks, maxNodes }) => {
            const hiddenTags = new Set(["script", "style", "noscript", "template"]);
            const boundedText = (root: Node | null): { value: string; totalLength: number; truncated: boolean } => {
              if (!root) return { value: "", totalLength: 0, truncated: false };
              const stack: Node[] = [root];
              let visited = 0;
              let totalLength = 0;
              let value = "";
              let truncated = false;
              while (stack.length > 0) {
                const node = stack.pop();
                if (!node) break;
                visited += 1;
                if (visited > maxNodes) {
                  truncated = true;
                  break;
                }
                if (node.nodeType === 3) {
                  const raw = node.nodeValue ?? "";
                  const nodeEnd = totalLength + raw.length;
                  if (value.length < limit && nodeEnd > start) {
                    const startInNode = Math.max(0, start - totalLength);
                    value += raw.slice(startInNode, startInNode + limit - value.length);
                  }
                  totalLength = nodeEnd;
                  if (value.length >= limit && nodeEnd > start + limit) {
                    truncated = true;
                    break;
                  }
                  continue;
                }
                if (node.nodeType !== 1) continue;
                const element = node as Element;
                if (hiddenTags.has(element.tagName.toLowerCase())) continue;
                const children = element.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) stack.push(child);
                }
              }
              return { value, totalLength, truncated: truncated || start + value.length < totalLength };
            };
            const links: Array<{ text: string; href: string }> = [];
            if (includeLinks && document.body) {
              const stack: Node[] = [document.body];
              let visited = 0;
              while (stack.length > 0 && links.length < 100) {
                const node = stack.pop();
                if (!node) break;
                visited += 1;
                if (visited > maxNodes) break;
                if (node.nodeType !== 1) continue;
                const element = node as Element;
                if (element.tagName.toLowerCase() === "a") {
                  const anchor = element as HTMLAnchorElement;
                  const rawHref = anchor.href || element.getAttribute("href") || "";
                  try {
                    const url = new URL(rawHref);
                    if (url.protocol === "http:" || url.protocol === "https:") {
                      url.username = "";
                      url.password = "";
                      const textStack: Node[] = [element];
                      let linkText = "";
                      let textNodes = 0;
                      while (textStack.length > 0 && linkText.length < 500 && textNodes < 512) {
                        const textNode = textStack.pop();
                        if (!textNode) break;
                        textNodes += 1;
                        if (textNode.nodeType === 3) {
                          linkText += (textNode.nodeValue ?? "").slice(0, 500 - linkText.length);
                          continue;
                        }
                        if (textNode.nodeType !== 1) continue;
                        const children = (textNode as Element).childNodes;
                        for (let index = children.length - 1; index >= 0; index -= 1) {
                          const child = children[index];
                          if (child) textStack.push(child);
                        }
                      }
                      links.push({ text: linkText.trim(), href: url.toString() });
                    }
                  } catch {
                    // Ignore malformed or non-HTTP links.
                  }
                }
                const children = element.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) stack.push(child);
                }
              }
            }
            const slice = boundedText(document.body);
            return { value: slice.value, totalLength: slice.totalLength, truncated: slice.truncated, links: includeLinks ? links : undefined };
          }, { start: offset, limit: maxChars, includeLinks, maxNodes: MAX_DOM_TRAVERSAL_NODES })) as {
            value: string;
            formValue?: string;
            totalLength: number;
            truncated: boolean;
            links?: Array<{ text: string; href: string }>;
          };
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
          ...(extracted.formValue !== undefined ? { formValue: wrapUntrustedText("extracted_form_value", redactSecretPlaceholders(extracted.formValue), maxChars) } : {}),
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
          ? await frame.$eval(await this.selectorFor(state, selector, action.frameId, frame), (element, limit: number) => {
            const serialize = (root: Node | null): { html: string; truncated: boolean } => {
              if (!root) {
                return { html: "", truncated: false };
              }
              // Keep compatibility with small test/adapter DOM shims without
              // taking this fallback on real browser nodes.
              if (!("childNodes" in root)) {
                const raw = String((root as Element).outerHTML ?? "");
                return { html: raw.slice(0, limit), truncated: raw.length > limit };
              }
              const capacity = Math.max(1, limit + 1);
              let html = "";
              let truncated = false;
              const append = (value: string): void => {
                if (truncated || !value) return;
                const remaining = capacity - html.length;
                if (remaining <= 0) {
                  truncated = true;
                  return;
                }
                if (value.length > remaining) {
                  html += value.slice(0, remaining);
                  truncated = true;
                } else {
                  html += value;
                }
              };
              const appendEscaped = (value: string, attribute = false): void => {
                let index = 0;
                while (index < value.length && !truncated) {
                  const character = value[index] ?? "";
                  const escaped = character === "&" ? "&amp;"
                    : character === "<" ? "&lt;"
                      : character === ">" ? "&gt;"
                        : attribute && character === "\"" ? "&quot;"
                          : attribute && character === "'" ? "&#39;"
                            : character;
                  append(escaped);
                  index += 1;
                }
                if (index < value.length) {
                  truncated = true;
                }
              };
              const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
              const stack: Array<{ node: Node; closing?: string; suppressText?: boolean }> = [{ node: root }];
              let visited = 0;
              while (stack.length > 0 && !truncated) {
                const entry = stack.pop();
                if (!entry) break;
                visited += 1;
                if (visited > 20_000) {
                  truncated = true;
                  break;
                }
                if (entry.closing) {
                  append(entry.closing);
                  continue;
                }
                const node = entry.node;
                if (node.nodeType === 3) {
                  if (entry.suppressText) {
                    continue;
                  }
                  appendEscaped(node.nodeValue ?? "");
                  continue;
                }
                if (node.nodeType !== 1) {
                  continue;
                }
                const current = node as Element;
                const tag = current.tagName.toLowerCase().slice(0, 100);
                if (tag === "script") {
                  continue;
                }
                append(`<${tag}`);
                const attributes = current.attributes;
                const attributeCount = Math.min(attributes.length, 40);
                for (let index = 0; index < attributeCount && !truncated; index += 1) {
                  const attribute = attributes[index];
                  if (!attribute || /^(?:value|srcdoc|autocomplete|on[a-z]+|data-)/i.test(attribute.name)) {
                    continue;
                  }
                  append(` ${attribute.name.slice(0, 100)}="`);
                  appendEscaped(attribute.value.slice(0, 500), true);
                  append("\"");
                  if (attribute.value.length > 500) {
                    truncated = true;
                  }
                }
                if (attributes.length > attributeCount) {
                  truncated = true;
                }
                append(">");
                if (voidTags.has(tag)) {
                  continue;
                }
                const suppressText = entry.suppressText === true || tag === "textarea";
                stack.push({ node, closing: `</${tag}>` });
                const children = current.childNodes;
                for (let index = children.length - 1; index >= 0; index -= 1) {
                  const child = children[index];
                  if (child) stack.push({ node: child, suppressText });
                }
              }
              if (stack.length > 0) {
                truncated = true;
              }
              return { html: html.slice(0, limit), truncated: truncated || html.length > limit };
            };
            return serialize(element);
          }, maxChars).catch((error: unknown) => {
            // Only a genuine miss may degrade to ELEMENT_NOT_FOUND below;
            // execution/timeout/cancellation failures must surface as-is.
            if (isMissingElementError(error)) {
              return undefined;
            }
            throw normalizeBrowserOperationError(error, signal);
          })
          : await frame.evaluate((limit: number) => {
            const root = document.documentElement;
            if (!root) return { html: "", truncated: false };
            const capacity = Math.max(1, limit + 1);
            let html = "";
            let truncated = false;
            const append = (value: string): void => {
              if (truncated || !value) return;
              const remaining = capacity - html.length;
              if (remaining <= 0) {
                truncated = true;
                return;
              }
              if (value.length > remaining) {
                html += value.slice(0, remaining);
                truncated = true;
              } else {
                html += value;
              }
            };
            const appendEscaped = (value: string, attribute = false): void => {
              let index = 0;
              while (index < value.length && !truncated) {
                const character = value[index] ?? "";
                append(character === "&" ? "&amp;"
                  : character === "<" ? "&lt;"
                    : character === ">" ? "&gt;"
                      : attribute && character === "\"" ? "&quot;"
                        : attribute && character === "'" ? "&#39;"
                          : character);
                index += 1;
              }
              if (index < value.length) truncated = true;
            };
            const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
            const stack: Array<{ node: Node; closing?: string; suppressText?: boolean }> = [{ node: root }];
            let visited = 0;
            while (stack.length > 0 && !truncated) {
              const entry = stack.pop();
              if (!entry) break;
              visited += 1;
              if (visited > 20_000) {
                truncated = true;
                break;
              }
              if (entry.closing) {
                append(entry.closing);
                continue;
              }
              const node = entry.node;
              if (node.nodeType === 3) {
                if (entry.suppressText) {
                  continue;
                }
                appendEscaped(node.nodeValue ?? "");
                continue;
              }
              if (node.nodeType !== 1) continue;
              const element = node as Element;
              const tag = element.tagName.toLowerCase().slice(0, 100);
              if (tag === "script") continue;
              append(`<${tag}`);
              const attributes = element.attributes;
              const attributeCount = Math.min(attributes.length, 40);
              for (let index = 0; index < attributeCount && !truncated; index += 1) {
                const attribute = attributes[index];
                if (!attribute || /^(?:value|srcdoc|autocomplete|on[a-z]+|data-)/i.test(attribute.name)) continue;
                append(` ${attribute.name.slice(0, 100)}="`);
                appendEscaped(attribute.value.slice(0, 500), true);
                append("\"");
                if (attribute.value.length > 500) truncated = true;
              }
              if (attributes.length > attributeCount) truncated = true;
              append(">");
              if (voidTags.has(tag)) continue;
              const suppressText = entry.suppressText === true || tag === "textarea";
              stack.push({ node, closing: `</${tag}>` });
              const children = element.childNodes;
              for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (child) stack.push({ node: child, suppressText });
              }
            }
            if (stack.length > 0) truncated = true;
            return { html: html.slice(0, limit), truncated: truncated || html.length > limit };
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
        // Validate the actual staging pathname too. This rejects an output
        // path that is itself an allowed directory before Chromium can write a
        // sibling temporary file outside the configured root.
        this.policy.assertFilePath(temporaryPath);
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
        if (state.downloadConfigurationError && !state.downloadConfigured) {
          throw state.downloadConfigurationError;
        }
        return this.listDownloads(signal);
      case "dropdown_options": {
        const selector = await this.selectorFor(state, targetForAction(action, "selector"), action.frameId, frame);
        const options = await frame.$$eval(selector, (elements) => {
          const boundedText = (root: Node): string => {
            const stack: Node[] = [root];
            let output = "";
            let visited = 0;
            while (stack.length > 0 && output.length < 500) {
              const node = stack.pop();
              if (!node) break;
              visited += 1;
              if (visited > 512) break;
              if (node.nodeType === 3) {
                output += (node.nodeValue ?? "").slice(0, 500 - output.length);
                continue;
              }
              if (node.nodeType !== 1) continue;
              const children = (node as Element).childNodes;
              for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (child) stack.push(child);
              }
            }
            return output.trim().slice(0, 500);
          };
          const output: Array<{ value: string; label: string; selected: boolean }> = [];
          for (const element of elements.slice(0, 50)) {
            for (const option of Array.from((element as HTMLSelectElement).options ?? []).slice(0, 200)) {
              if (output.length >= 200) break;
              output.push({ value: option.value.slice(0, 500), label: boundedText(option), selected: option.selected });
            }
            if (output.length >= 200) break;
          }
          return output;
        });
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
        const result = await frame.evaluate(({ start, limit, maxNodes }) => {
          const root = document.body;
          if (!root) return { text: "", totalLength: 0, hasMore: false };
          const hiddenTags = new Set(["script", "style", "noscript", "template"]);
          const stack: Node[] = [root];
          let visited = 0;
          let totalLength = 0;
          let text = "";
          let scanTruncated = false;
          while (stack.length > 0) {
            const node = stack.pop();
            if (!node) break;
            visited += 1;
            if (visited > maxNodes) {
              scanTruncated = true;
              break;
            }
            if (node.nodeType === 3) {
              const raw = node.nodeValue ?? "";
              const nodeEnd = totalLength + raw.length;
              if (text.length < limit && nodeEnd > start) {
                const startInNode = Math.max(0, start - totalLength);
                text += raw.slice(startInNode, startInNode + limit - text.length);
              }
              totalLength = nodeEnd;
              if (text.length >= limit && nodeEnd > start + limit) {
                return { text, totalLength, hasMore: true };
              }
              continue;
            }
            if (node.nodeType !== 1) continue;
            const element = node as Element;
            if (hiddenTags.has(element.tagName.toLowerCase())) continue;
            const children = element.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push(child);
            }
          }
          return { text, totalLength, hasMore: scanTruncated || start + text.length < totalLength };
        }, { start: offset, limit: maxChars, maxNodes: MAX_DOM_TRAVERSAL_NODES });
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
        const matches = await frame.evaluate((needle, options: { maxNodes: number; maxChars: number }) => {
          const root = document.body;
          if (!root) return { matches: [], totalMatches: 0, scanTruncated: false };
          const target = needle.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
          if (!target) return { matches: [], totalMatches: 0, scanTruncated: false };
          const hiddenTags = new Set(["script", "style", "noscript", "template"]);
          const stack: Node[] = [root];
          let visited = 0;
          let text = "";
          let scanTruncated = false;
          while (stack.length > 0) {
            const node = stack.pop();
            if (!node) break;
            visited += 1;
            if (visited > options.maxNodes) {
              scanTruncated = true;
              break;
            }
            if (node.nodeType === 3) {
              const remaining = options.maxChars - text.length;
              if (remaining <= 0) {
                scanTruncated = true;
                break;
              }
              const raw = node.nodeValue ?? "";
              text += raw.slice(0, remaining);
              if (raw.length > remaining) {
                scanTruncated = true;
                break;
              }
              continue;
            }
            if (node.nodeType !== 1) continue;
            const element = node as Element;
            if (hiddenTags.has(element.tagName.toLowerCase())) continue;
            const children = element.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push(child);
            }
          }
          const normalizedText = text.normalize("NFKC").replace(/\s+/g, " ");
          const lower = normalizedText.toLowerCase();
          const output: string[] = [];
          let index = lower.indexOf(target);
          let totalMatches = 0;
          while (index >= 0 && output.length < 20) {
            output.push(normalizedText.slice(Math.max(0, index - 120), Math.min(normalizedText.length, index + target.length + 120)));
            totalMatches += 1;
            index = lower.indexOf(target, index + target.length);
          }
          while (index >= 0) {
            totalMatches += 1;
            index = lower.indexOf(target, index + target.length);
          }
          return { matches: output, totalMatches, scanTruncated };
        }, query, { maxNodes: MAX_DOM_TRAVERSAL_NODES, maxChars: MAX_TEXT_SCAN_CHARS });
        return { query, matches: matches.matches.map((match) => wrapUntrustedText("page_match", redactSecretPlaceholders(match), 500)), totalMatches: matches.totalMatches, matchesTruncated: matches.totalMatches > matches.matches.length || matches.scanTruncated };
      }
      case "find_elements": {
        const selector = targetForAction(action, "selector");
        const safeSelector = await this.selectorFor(state, selector, action.frameId, frame);
        function collectFindElements(matches: Element[], fallbackSelector: string): Array<{ tag: string; selector: string; rect: { x: number; y: number; width: number; height: number }; text: string; attributes: Record<string, string>; omittedAttributes: number }> {
          const boundedText = (root: Element): string => {
            const maybeChildNodes = (root as unknown as { childNodes?: unknown }).childNodes;
            if (!maybeChildNodes) {
              return String((root as unknown as { textContent?: unknown }).textContent ?? "").trim().slice(0, 300);
            }
            const stack: Node[] = [root];
            let output = "";
            let visited = 0;
            while (stack.length > 0 && output.length < 300) {
              const node = stack.pop();
              if (!node) break;
              visited += 1;
              if (visited > 512) break;
              if (node.nodeType === 3) {
                output += (node.nodeValue ?? "").slice(0, 300 - output.length);
                continue;
              }
              if (node.nodeType !== 1) continue;
              const children = (node as Element).childNodes;
              for (let index = children.length - 1; index >= 0; index -= 1) {
                const child = children[index];
                if (child) stack.push(child);
              }
            }
            return output.trim().slice(0, 300);
          };
          return matches.slice(0, 50).map((element) => {
          let elementSelector = fallbackSelector;
          let usedUniqueId = false;
          const root = element.getRootNode();
          if (root === document) {
            const id = element.getAttribute("id");
            if (id) {
              try {
                // getElementById is a targeted lookup and avoids turning a
                // large find_elements result into another full selector scan.
                // Snapshot refs still verify their signature before use.
                if (document.getElementById(id) === element) {
                  elementSelector = `#${CSS.escape(id)}`;
                  usedUniqueId = true;
                }
              } catch {
                // Fall through to the bounded structural selector.
              }
            }
            if (!usedUniqueId) {
              const parts: string[] = [];
              let current: Element | null = element;
              while (current && current !== document.body && parts.length < 8) {
                const parent: HTMLElement | null = current.parentElement;
                const tag = current.tagName.toLowerCase();
                if (!parent) {
                  parts.unshift(tag);
                  break;
                }
                const currentTagName = current.tagName;
                let siblingIndex = 0;
                let currentIndex = 0;
                for (let childIndex = 0; childIndex < parent.children.length; childIndex += 1) {
                  const child = parent.children[childIndex];
                  if (!child || child.tagName !== currentTagName) continue;
                  siblingIndex += 1;
                  if (child === current) currentIndex = siblingIndex;
                }
                parts.unshift(`${tag}:nth-of-type(${currentIndex || 1})`);
                current = parent;
              }
              elementSelector = parts.join(" > ").slice(0, 500) || fallbackSelector;
            }
          }
          const rect = element.getBoundingClientRect();
          const boundedX = Number.isFinite(rect.x) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(rect.x))) : 0;
          const boundedY = Number.isFinite(rect.y) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(rect.y))) : 0;
          const boundedWidth = Number.isFinite(rect.width) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(rect.width))) : 0;
          const boundedHeight = Number.isFinite(rect.height) ? Math.max(-10_000_000, Math.min(10_000_000, Math.round(rect.height))) : 0;
          const attributes: Record<string, string> = {};
          let omittedAttributes = 0;
          // These attributes describe bounded, visible DOM geometry/state and
          // are useful for agents operating SVG/canvas-adjacent widgets. They
          // are still wrapped, truncated, and never treated as executable.
          const safeAttributes = new Set(["id", "class", "role", "type", "name", "placeholder", "title", "tabindex", "style", "fill", "stroke", "x", "y", "x1", "x2", "y1", "y2", "r", "cx", "cy", "width", "height", "points", "transform", "font-size"]);
          const safeDataAttributes = new Set(["data-color", "data-index", "data-sides", "data-result", "data-key", "data-type", "data-item", "data-id", "data-start", "data-end", "data-duration", "data-output", "data-value", "data-position", "data-price"]);
          const attributeCount = element.attributes.length;
          const inspectedAttributes = Math.min(attributeCount, 40);
          for (let index = 0; index < inspectedAttributes; index += 1) {
            const attribute = element.attributes[index];
            if (!attribute) continue;
            const name = attribute.name.toLowerCase();
            const allowed = safeAttributes.has(name) || safeDataAttributes.has(name) || /^aria-[a-z0-9_-]+$/i.test(name);
            if (!allowed) {
              omittedAttributes += 1;
              continue;
            }
            attributes[name.slice(0, 100)] = attribute.value.slice(0, 200);
            if (attribute.value.length > 200) omittedAttributes += 1;
          }
          omittedAttributes += Math.max(0, attributeCount - inspectedAttributes);
          return {
            tag: element.tagName.toLowerCase(),
            selector: elementSelector,
            rect: { x: boundedX, y: boundedY, width: boundedWidth, height: boundedHeight },
            text: boundedText(element),
            attributes,
            omittedAttributes,
          };
          });
        }
        const elements = await frame.$$eval(safeSelector, collectFindElements, safeSelector);
        return elements.map((element) => ({
          tag: element.tag,
          selector: wrapUntrustedText("element_selector", redactSecretPlaceholders(element.selector), 500),
          rect: element.rect,
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
        return this.accessibilitySnapshot(state, action.maxNodes ?? 500, action.maxChars ?? 40_000, action.interestingOnly ?? true, frame, signal);
      case "get_computed_style": {
        const selector = await this.selectorFor(state, targetForAction(action, "selector"), action.frameId, frame);
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
      case "move": {
        if (action.frameId && action.frameId !== "main") {
          throw new AppError("FRAME_ACTION_UNSUPPORTED", "Coordinate moves target the top-level viewport; use a selector for a child frame.");
        }
        const coordinateX = action.coordinateX ?? action.coordinate_x;
        const coordinateY = action.coordinateY ?? action.coordinate_y;
        if (coordinateX === undefined || coordinateY === undefined) {
          throw new AppError("INVALID_ACTION", "coordinateX and coordinateY must be provided together.");
        }
        const viewport = page.viewport() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        if (coordinateX < 0 || coordinateY < 0 || coordinateX >= viewport.width || coordinateY >= viewport.height) {
          throw new AppError("COORDINATE_OUT_OF_BOUNDS", `The pointer coordinate (${coordinateX}, ${coordinateY}) is outside the ${viewport.width}x${viewport.height} viewport.`);
        }
        await page.mouse.move(coordinateX, coordinateY);
        return { moved: true, x: coordinateX, y: coordinateY, pageId: state.id };
      }
      case "hover":
        await frame.hover(await this.selectorFor(state, targetForAction(action, "target"), action.frameId, frame));
        return { hovered: true };
      case "press_and_hold": {
        const selector = await this.selectorFor(state, targetForAction(action, "target"), action.frameId, frame);
        const targetHandle = await frame.$(selector);
        let mouseButtonMayBeDown = false;
        const startCoordinateX = action.startCoordinateX ?? action.start_coordinate_x;
        const startCoordinateY = action.startCoordinateY ?? action.start_coordinate_y;
        const endCoordinateX = action.endCoordinateX ?? action.end_coordinate_x;
        const endCoordinateY = action.endCoordinateY ?? action.end_coordinate_y;
        const path = action.path;
        if ((startCoordinateX === undefined) !== (startCoordinateY === undefined)) {
          await targetHandle?.dispose().catch(() => undefined);
          throw new AppError("INVALID_ACTION", "startCoordinateX and startCoordinateY must be provided together.");
        }
        if ((endCoordinateX === undefined) !== (endCoordinateY === undefined)) {
          await targetHandle?.dispose().catch(() => undefined);
          throw new AppError("INVALID_ACTION", "endCoordinateX and endCoordinateY must be provided together.");
        }
        if (path !== undefined && (startCoordinateX !== undefined || startCoordinateY !== undefined || endCoordinateX !== undefined || endCoordinateY !== undefined)) {
          await targetHandle?.dispose().catch(() => undefined);
          throw new AppError("INVALID_ACTION", "Provide path or start/end coordinates, not both.");
        }
        try {
          const scrollIntoView = (targetHandle as unknown as { scrollIntoView?: () => Promise<void> } | null)?.scrollIntoView;
          if (scrollIntoView) {
            await scrollIntoView.call(targetHandle);
          }
          throwIfAborted(signal);
          const clickablePoint = (targetHandle as unknown as { clickablePoint?: () => Promise<{ x: number; y: number }> } | null)?.clickablePoint;
          const clickable = clickablePoint
            ? await clickablePoint.call(targetHandle)
            : await (async () => {
              const bounds = await targetHandle?.boundingBox();
              if (!bounds) {
                throw new AppError("ELEMENT_NOT_FOUND", "The hold target is detached or not visible.");
              }
              return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
            })();
          const point = path?.[0]
            ?? (startCoordinateX !== undefined && startCoordinateY !== undefined
              ? { x: startCoordinateX, y: startCoordinateY }
              : clickable);
          if (path !== undefined && path.length < 2) {
            throw new AppError("INVALID_ACTION", "path must contain at least two points.");
          }
          if (path !== undefined && action.frameId && action.frameId !== "main") {
            throw new AppError("FRAME_ACTION_UNSUPPORTED", "Pointer paths target the top-level viewport; use a selector/ref in the main frame.");
          }
          if (path !== undefined && path.some((item) => !Number.isFinite(item.x) || !Number.isFinite(item.y))) {
            throw new AppError("INVALID_ACTION", "Every pointer path point must contain finite x and y coordinates.");
          }
          if (path !== undefined && path.some((item) => item.x < 0 || item.y < 0)) {
            throw new AppError("COORDINATE_OUT_OF_BOUNDS", "Pointer path coordinates must be non-negative.");
          }
          if (startCoordinateX !== undefined && startCoordinateY !== undefined && path === undefined) {
            if (action.frameId && action.frameId !== "main") {
              throw new AppError("FRAME_ACTION_UNSUPPORTED", "Drag start coordinates target the top-level viewport; use a selector/ref in the main frame.");
            }
            const viewport = page.viewport() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
            if (startCoordinateX < 0 || startCoordinateY < 0 || startCoordinateX >= viewport.width || startCoordinateY >= viewport.height) {
              throw new AppError("COORDINATE_OUT_OF_BOUNDS", `The drag start (${startCoordinateX}, ${startCoordinateY}) is outside the ${viewport.width}x${viewport.height} viewport.`);
            }
          }
          throwIfAborted(signal);
          await page.mouse.move(point.x, point.y);
          throwIfAborted(signal);
          const button = action.button ?? "left";
          if (endCoordinateX !== undefined && endCoordinateY !== undefined) {
            if (action.frameId && action.frameId !== "main") {
              throw new AppError("FRAME_ACTION_UNSUPPORTED", "Drag destinations target the top-level viewport; use a selector/ref in the main frame.");
            }
            const viewport = page.viewport() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
            if (endCoordinateX < 0 || endCoordinateY < 0 || endCoordinateX >= viewport.width || endCoordinateY >= viewport.height) {
              throw new AppError("COORDINATE_OUT_OF_BOUNDS", `The drag destination (${endCoordinateX}, ${endCoordinateY}) is outside the ${viewport.width}x${viewport.height} viewport.`);
            }
          }
          // Treat a failed mouse.down as potentially pressed: Chromium can
          // reject after sending the input event. Always attempt the matching
          // mouse.up so cancellation and setup failures do not leak a held
          // pointer into the next action.
          mouseButtonMayBeDown = true;
          await page.mouse.down({ button });
          try {
            await wait(action.durationMs ?? action.milliseconds ?? 2_000, signal);
            if (path !== undefined) {
              const viewport = page.viewport() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
              for (const item of path) {
                if (item.x >= viewport.width || item.y >= viewport.height) {
                  throw new AppError("COORDINATE_OUT_OF_BOUNDS", `The pointer path coordinate (${item.x}, ${item.y}) is outside the ${viewport.width}x${viewport.height} viewport.`);
                }
              }
              for (const item of path.slice(1)) {
                throwIfAborted(signal);
                await page.mouse.move(item.x, item.y);
              }
            } else if (endCoordinateX !== undefined && endCoordinateY !== undefined) {
              const distance = Math.hypot(endCoordinateX - point.x, endCoordinateY - point.y);
              const steps = Math.min(64, Math.max(1, Math.ceil(distance / 8)));
              await page.mouse.move(endCoordinateX, endCoordinateY, { steps });
            }
          } finally {
            if (mouseButtonMayBeDown) {
              await page.mouse.up({ button }).catch(() => undefined);
              mouseButtonMayBeDown = false;
            }
          }
          return {
            heldMs: action.durationMs ?? action.milliseconds ?? 2_000,
            ...(path !== undefined ? { draggedPath: path.length } : endCoordinateX !== undefined && endCoordinateY !== undefined ? { draggedTo: { x: endCoordinateX, y: endCoordinateY } } : {}),
          };
        } finally {
          if (mouseButtonMayBeDown) {
            await page.mouse.up({ button: action.button ?? "left" }).catch(() => undefined);
          }
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
    await this.assertCurrentPageAllowed(state.page, state);
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
        if (DOM_MUTATING_ACTIONS.has(action.action)) {
          this.invalidateActionSnapshot(action, undefined);
        }
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
      if (pageId) {
        throw new AppError("TAB_NOT_FOUND", `Tab '${pageId}' was not found.`);
      }
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
        this.targetGuardNavigationErrors.delete(guard.targetId);
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
    this.targetGuardNavigationErrors.clear();
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
    const resourceType = typeof event.resourceType === "string" ? event.resourceType : "";
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
      } else if (/^chrome-error:\/\//i.test(requestUrl)) {
        // Chromium may expose its internal error document after a blocked
        // redirect. It is not an external navigation and must not overwrite
        // the policy error for the original request.
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
      const normalized = error instanceof AppError ? error : new AppError("NAVIGATION_BLOCKED", "The browser navigation was blocked by policy.", { cause: error });
      if (guard.targetType === "page" && resourceType === "Document" && /^https?:\/\//i.test(requestUrl)) {
        this.targetGuardNavigationErrors.set(guard.targetId, normalized);
      }
      this.logger.warn("New browser target request blocked", { url: safeUrl(requestUrl), code: normalized.code });
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
    const identity = pageTargetIdentity(page);
    if (identity.sessionId) {
      return this.targetGuardSessions.get(identity.sessionId);
    }
    if (identity.targetId) {
      return [...this.targetGuardSessions.values()].find((guard) => guard.targetId === identity.targetId);
    }
    return undefined;
  }

  private clearTargetGuardNavigationError(page: Page): void {
    const targetId = pageTargetIdentity(page).targetId;
    if (targetId) {
      this.targetGuardNavigationErrors.delete(targetId);
    }
  }

  private takeTargetGuardNavigationError(page: Page): AppError | undefined {
    const targetId = pageTargetIdentity(page).targetId;
    if (!targetId) {
      return undefined;
    }
    const error = this.targetGuardNavigationErrors.get(targetId);
    this.targetGuardNavigationErrors.delete(targetId);
    return error;
  }

  private async waitForTargetGuardDrain(page: Page, signal?: AbortSignal): Promise<void> {
    const guard = this.targetGuardForPage(page);
    if (guard?.pendingRequests.size) {
      await awaitWithAbort(Promise.allSettled([...guard.pendingRequests]).then(() => undefined), signal);
    }
  }

  private async releaseTargetGuardForPage(page: Page): Promise<void> {
    const identity = pageTargetIdentity(page);
    const guard = this.targetGuardForPage(page);
    if (!identity.sessionId && !guard) return;
    if (identity.sessionId) {
      this.unguardedTargetSessions.delete(identity.sessionId);
    }
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
    this.targetGuardSessions.delete(guard.session.id());
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
    const identity = pageTargetIdentity(page);
    return Boolean(identity.sessionId && this.unguardedTargetSessions.has(identity.sessionId));
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

  private async recoverBlockedNavigation(state: PageState): Promise<void> {
    if (isPageClosed(state.page)) {
      return;
    }
    try {
      await state.page.goto("about:blank", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(this.config.browser.actionTimeoutMs, 2_000),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      state.navigationError = undefined;
      this.clearTargetGuardNavigationError(state.page);
      state.policyVerifiedUrls?.clear();
      state.challengeActive = false;
    } catch (error) {
      this.logger.debug("Blocked navigation recovery could not restore a blank page", { pageId: state.id, error: String(error) });
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
    const viewportSession = state.viewportSession;
    state.viewportSession = undefined;
    void viewportSession?.detach().catch(() => undefined);
    state.refs.clear();
    state.snapshotInteractive = undefined;
    state.snapshotId = undefined;
    state.policyVerifiedUrls?.clear();
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
    if (this.config.browser.viewport && !state.viewportConfigured) {
      throwIfAborted(signal);
      // Keep Puppeteer's input coordinate map in sync with the CDP metrics.
      // Connected pages can report the correct CSS viewport while Puppeteer
      // still has a null/stale viewport, which makes mouse hit testing drift
      // on small inline controls. This is applied only for an explicit
      // viewport override; normal personal-browser sessions remain untouched.
      await state.page.setViewport({
        width: this.config.browser.viewport.width,
        height: this.config.browser.viewport.height,
        deviceScaleFactor: 1,
      });
      const session = await state.page.createCDPSession();
      try {
        await session.send("Emulation.setDeviceMetricsOverride", {
          width: this.config.browser.viewport.width,
          height: this.config.browser.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        state.viewportSession = session;
        state.viewportConfigured = true;
      } catch (error) {
        await session.detach().catch(() => undefined);
        throw error;
      }
      this.assertStateLive(state);
    }
    if (!state.downloadConfigured && !state.downloadConfigurationError) {
      try {
        const downloadPath = resolve(this.config.dataDir, "downloads");
        await awaitWithAbort(mkdir(downloadPath, { recursive: true, mode: 0o700 }), signal);
        try {
          // Puppeteer exposes the context at runtime, while its stable public
          // BrowserContext type does not yet declare this CDP-backed helper.
          const context = state.page.browserContext() as unknown as { setDownloadBehavior?: (behavior: { policy: "allow"; downloadPath: string }) => Promise<void> };
          if (!context.setDownloadBehavior) {
            throw new AppError("DOWNLOAD_CONFIGURATION_FAILED", "The connected browser does not expose context download behavior.");
          }
          if (!this.configuredDownloadContexts.has(context)) {
            await awaitWithAbort(context.setDownloadBehavior({ policy: "allow", downloadPath }), signal);
            this.configuredDownloadContexts.add(context);
          }
          state.downloadConfigured = true;
          state.downloadConfigurationError = undefined;
        } catch {
          throwIfAborted(signal);
          // Older Chromium versions expose only the page-scoped command.
          const client = await awaitWithAbort(state.page.createCDPSession(), signal);
          try {
            await awaitWithAbort(client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath }), signal);
            state.downloadConfigured = true;
            state.downloadConfigurationError = undefined;
          } finally {
            await settleWithTimeout(client.detach().catch(() => undefined), 500);
          }
        }
      } catch (error) {
        throwIfAborted(signal);
        const classified = error instanceof AppError && error.code === "DOWNLOAD_CONFIGURATION_FAILED"
          ? error
          : new AppError("DOWNLOAD_CONFIGURATION_FAILED", "The browser download directory could not be configured. Retry after reconnecting the browser.", { retryable: true, cause: error });
        state.downloadConfigurationError = classified;
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
    // Pages that existed before the browser connection was fully wired do not
    // receive a targetcreated callback. Release their initial CDP pause only
    // after page-level request interception is ready, just as for new pages.
    await this.releaseTargetGuardForPage(state.page);
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
      if (mainFrameNavigation && navigationGeneration !== undefined) {
        // Keep the exact-document admission cache for ordinary clicks that do
        // not navigate. Once a real main-frame request starts, the document
        // identity is changing and all frame URL admissions must be rebuilt.
        state.policyVerifiedUrls?.clear();
      }
      requestUrl = request.url();
      if (/^about:blank(?:#.*)?$/i.test(requestUrl)) {
        await request.continue();
        return;
      }
      if (/^chrome-error:\/\//i.test(requestUrl)) {
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
    const state: PageState = { id: randomUUID(), page, lifecycleGeneration: this.lifecycleGeneration, disposed: false, refs: new Map(), domRevision: 0, networkEnabled: false, consoleEnabled: false, network: [], console: [], dialogs: [], listenersInstalled: false, timeoutsConfigured: false, viewportConfigured: false, downloadConfigured: false, navigationGuardInstalled: false, navigationGeneration: 0, policyVerifiedUrls: new Set(), challengeActive: false };
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
      // A same-origin reload or child-frame navigation can keep the host
      // unchanged while replacing the document. Re-run the DNS admission for
      // the new frame URL rather than carrying the old document's cache.
      state.policyVerifiedUrls?.clear();
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
      state.policyVerifiedUrls?.clear();
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
      state.policyVerifiedUrls?.clear();
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

  private async accessibilitySnapshot(state: PageState, maxNodes: number, maxChars: number, interestingOnly: boolean, frame?: Frame, signal?: AbortSignal): Promise<unknown> {
    const client = await awaitWithAbort(state.page.createCDPSession(), signal);
    try {
      const frameId = frameProtocolId(frame);
      const nodeLimit = Number.isFinite(maxNodes) ? Math.max(1, Math.min(5_000, Math.floor(maxNodes))) : 500;
      // The protocol's full-tree call otherwise materializes an unbounded AX
      // tree. A shallow, bounded request keeps wide/hostile documents from
      // monopolizing the CDP connection; the response is still capped below.
      const depth = Math.min(24, Math.max(1, Math.ceil(Math.log2(nodeLimit + 1)) + 2));
      const response = await awaitWithAbort(client.send("Accessibility.getFullAXTree", { ...(frameId ? { frameId } : {}), depth }), signal) as unknown as { nodes?: Array<Record<string, unknown>> };
      const sourceNodes = Array.isArray(response.nodes) ? response.nodes : [];
      const nodes: Array<Record<string, unknown>> = [];
      let sourceTruncated = false;
      for (const node of sourceNodes) {
        if (interestingOnly && !isInterestingAxNode(node)) {
          continue;
        }
        if (nodes.length >= nodeLimit) {
          sourceTruncated = true;
          break;
        }
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
        nodes.push({
          ref: `ax-${nodes.length + 1}`,
          role: role ? role.slice(0, 200) : "unknown",
          name: wrapUntrustedText("accessibility_name", redactSecretPlaceholders(name.slice(0, 500)), 500),
          ...(value ? { value: wrapUntrustedText("accessibility_value", redactSecretPlaceholders(value.slice(0, 500)), 500) } : {}),
          properties,
        });
      }
      const boundedNodes = boundAccessibilityNodes(nodes, maxChars);
      return {
        pageId: state.id,
        // Only advertise a registered snapshot id; fabricating one here would
        // let clients act on an id that PageState never recorded.
        ...(state.snapshotId ? { snapshotId: state.snapshotId } : {}),
        nodes: boundedNodes.nodes,
        truncated: sourceTruncated || boundedNodes.truncated,
      };
    } finally {
      await settleWithTimeout(Promise.resolve().then(() => client.detach()).catch(() => undefined), 500);
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
        await this.assertFrameUrlAllowed(state, url);
      }
    } catch (error) {
      if (isFrameDetached(frame)) {
        throw new AppError("FRAME_NOT_FOUND", `Frame '${expected}' was not found. Refresh browser_frames and retry.`, { retryable: true });
      }
      throw error;
    }
    return frame;
  }

  private async selectorFor(state: PageState, target: string, requestedFrameId?: string, resolvedFrame?: Frame): Promise<string> {
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
      let frame = resolvedFrame;
      if (frame) {
        try {
          if (framePath(frame) !== stored.frameId) {
            frame = undefined;
          }
        } catch {
          frame = undefined;
        }
      }
      frame ??= await this.frameFor(state, stored.frameId);
      const currentSignature = await frame.$eval(stored.selector, (element) => {
        const htmlElement = element as HTMLElement & { type?: string };
        const anchor = element.closest("a") as HTMLAnchorElement | null;
        const boundedText = (root: Node): string => {
          const hiddenTags = new Set(["script", "style", "noscript", "template"]);
          const stack: Array<{ node: Node; hidden: boolean }> = [{ node: root, hidden: false }];
          let output = "";
          let visited = 0;
          while (stack.length > 0 && output.length < 500) {
            const entry = stack.pop();
            if (!entry) break;
            visited += 1;
            if (visited > 512) break;
            if (entry.node.nodeType === 3) {
              if (!entry.hidden) output += (entry.node.nodeValue ?? "").slice(0, 500 - output.length);
              continue;
            }
            if (entry.node.nodeType !== 1) continue;
            const current = entry.node as Element;
            if (hiddenTags.has(current.tagName.toLowerCase())) continue;
            const style = current.getAttribute("style") ?? "";
            const hidden = entry.hidden
              || current.hasAttribute("hidden")
              || current.getAttribute("aria-hidden") === "true"
              || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
            const children = current.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push({ node: child, hidden });
            }
          }
          return output;
        };
        const text = boundedText(element).replace(/\s+/g, " ").trim().slice(0, 500);
        return [
          element.tagName.toLowerCase(),
          element.getAttribute("id") ?? "",
          element.getAttribute("name") ?? "",
          element.getAttribute("role") ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("placeholder") ?? "",
          element.getAttribute("disabled") ?? "",
          element.getAttribute("aria-disabled") ?? "",
          htmlElement.type ?? "",
          text || element.getAttribute("value") || "",
          (anchor?.href ?? "").slice(0, 4_096),
        ].join("\u001f");
      }).catch(() => undefined);
      if (!currentSignature || currentSignature !== stored.signature) {
        throw new AppError("STALE_REFERENCE", `Element reference '${ref}' no longer identifies the same element. Capture a fresh browser snapshot before acting.`, { retryable: true });
      }
      return stored.selector;
    }
    if (resolvedFrame) {
      return normalized;
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
      const boundedText = (root: Node): string => {
        const hiddenTags = new Set(["script", "style", "noscript", "template"]);
        const stack: Array<{ node: Node; hidden: boolean }> = [{ node: root, hidden: false }];
        let output = "";
        let visited = 0;
        while (stack.length > 0 && output.length < 500) {
          const entry = stack.pop();
          if (!entry) break;
          visited += 1;
          if (visited > 512) break;
          if (entry.node.nodeType === 3) {
            if (!entry.hidden) output += (entry.node.nodeValue ?? "").slice(0, 500 - output.length);
            continue;
          }
          if (entry.node.nodeType !== 1) continue;
          const current = entry.node as Element;
          if (hiddenTags.has(current.tagName.toLowerCase())) continue;
          const style = current.getAttribute("style") ?? "";
          const hidden = entry.hidden
            || current.hasAttribute("hidden")
            || current.getAttribute("aria-hidden") === "true"
            || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
          const children = current.childNodes;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) stack.push({ node: child, hidden });
          }
        }
        return output;
      };
      const elementText = boundedText(element).replace(/\s+/g, " ").trim().slice(0, 500);
      const clickableText = boundedText(clickable).replace(/\s+/g, " ").trim().slice(0, 200);
      return {
        signature: [
          element.tagName.toLowerCase(),
          element.getAttribute("id") ?? "",
          element.getAttribute("name") ?? "",
          element.getAttribute("role") ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("placeholder") ?? "",
          element.getAttribute("disabled") ?? "",
          element.getAttribute("aria-disabled") ?? "",
          htmlElement.type ?? "",
          elementText || element.getAttribute("value") || "",
          (anchor?.href ?? "").slice(0, 4_096),
        ].join("\u001f"),
        tag: clickable.tagName.toLowerCase(),
        type: htmlElement.type?.toLowerCase() ?? "",
        role: clickable.getAttribute("role") ?? "",
        focusable: clickable instanceof HTMLElement && (clickable.hasAttribute("tabindex") || /^(?:button|input|select|textarea|a)$/i.test(clickable.tagName)),
        label: [clickableText, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
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
    const beforePages = new Set(await awaitWithAbort(browser.pages(), signal));
    const beforeUrl = state.page.url();
    let selector: string | undefined;
    try {
      selector = await this.selectorFor(state, target, "main", state.page.mainFrame());
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
      : await state.page.evaluate((needle, maxNodes) => {
        const normalizedTarget = needle.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
        if (!normalizedTarget || !document.body) return undefined;
        const hiddenTags = new Set(["script", "style", "noscript", "template"]);
        const boundedText = (root: Element): string => {
          const stack: Node[] = [root];
          let output = "";
          let visited = 0;
          while (stack.length > 0 && output.length < 2_000) {
            const node = stack.pop();
            if (!node) break;
            visited += 1;
            if (visited > 2_000) break;
            if (node.nodeType === 3) {
              output += (node.nodeValue ?? "").slice(0, 2_000 - output.length);
              continue;
            }
            if (node.nodeType !== 1) continue;
            const children = (node as Element).childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push(child);
            }
          }
          return output;
        };
        const stack: Array<{ element: Element; hidden: boolean }> = [{ element: document.body, hidden: false }];
        let visited = 0;
        while (stack.length > 0) {
          const entry = stack.pop();
          if (!entry) break;
          visited += 1;
          if (visited > maxNodes) break;
          const { element, hidden } = entry;
          const tag = element.tagName.toLowerCase();
          if (hiddenTags.has(tag)) continue;
          const style = element.getAttribute("style") ?? "";
          const locallyHidden = hidden
            || element.hasAttribute("hidden")
            || element.getAttribute("aria-hidden") === "true"
            || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
          if (element !== document.body && !locallyHidden && (element.children.length === 0 || element.children.length <= 8)) {
            const candidateText = boundedText(element).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
            if (candidateText === normalizedTarget) {
              const clickable = element.closest("a,button,[role=button],[onclick]");
              const anchor = clickable?.closest("a") as HTMLAnchorElement | null;
              if (anchor?.href || clickable?.getAttribute("href")) {
                return anchor?.href ?? clickable?.getAttribute("href");
              }
            }
          }
          const children = element.children;
          for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            if (child) stack.push({ element: child, hidden: locallyHidden });
          }
        }
        return undefined;
      }, target, MAX_DOM_TRAVERSAL_NODES).catch(() => undefined);
    if (!href) {
      return undefined;
    }
    throwIfAborted(signal);
    const popupSeed: PopupObservation = { createdPages: new Set<Page>(), pendingPagePromises: new Set<Promise<void>>() };
    let clickCompleted!: () => void;
    const clickCompletion = new Promise<void>((resolve) => {
      clickCompleted = resolve;
    });
    const popupPromise = this.waitForPopup(
      state.page,
      browser,
      beforePages,
      this.config.browser.actionTimeoutMs,
      signal,
      popupSeed,
      clickCompletion,
    );
    let popupObservation: PopupObservation | undefined;
    try {
      // Perform the real click first so target=_blank, window.open, POST forms,
      // and page handlers retain their browser semantics.
      try {
        await this.clickTarget(state, target, "left", 1, signal);
      } finally {
        clickCompleted();
      }
      popupObservation = await popupPromise;
      await awaitWithAbort(Promise.allSettled([...popupObservation.pendingPagePromises]).then(() => undefined), signal);
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
        return { clicked: true, pageId: state.id, openedPageId: next.id, url: safeUrl(next.page.url()) };
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
        return { clicked: true, pageId: state.id, openedPageId: next.id, url: safeUrl(next.page.url()), synthetic: true };
      }
      this.assertStateLive(state);
      return { clicked: true, pageId: state.id, url: safeUrl(state.page.url()) };
    } catch (error) {
      // A click can fail while the popup watcher is aborting. Always observe
      // that promise so its cancellation rejection cannot become unhandled.
      if (!popupObservation) {
        popupObservation = await popupPromise.catch(() => popupSeed);
      }
      await settleWithTimeout(Promise.allSettled([...popupObservation.pendingPagePromises]).then(() => undefined), 500);
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

  private waitForPopup(page: Page, browser: Browser, beforePages: Set<Page>, timeoutMs: number, signal?: AbortSignal, seed?: PopupObservation, clickCompleted?: Promise<void>): Promise<PopupObservation> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let postClickTimer: ReturnType<typeof setTimeout> | undefined;
      const observation = seed ?? { createdPages: new Set<Page>(), pendingPagePromises: new Set<Promise<void>>() };
      const finish = (popup?: Page, abandon = false): void => {
        if (settled) {
          return;
        }
        if (abandon) {
          observation.abandoned = true;
        }
        settled = true;
        clearTimeout(timer);
        if (postClickTimer) {
          clearTimeout(postClickTimer);
          postClickTimer = undefined;
        }
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
        observation.abandoned = true;
        clearTimeout(timer);
        if (postClickTimer) {
          clearTimeout(postClickTimer);
          postClickTimer = undefined;
        }
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
            if (popup && observation.abandoned) {
              void closePageSafely(popup);
              return;
            }
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
      const timer = setTimeout(() => finish(undefined, true), Math.max(1, Math.floor(timeoutMs)));
      const onAbort = (): void => fail(new AppError("CANCELLED", "The browser action was cancelled."));
      const onPageClose = (): void => finish();
      const armPostClickTimer = (): void => {
        if (settled) return;
        postClickTimer = setTimeout(() => finish(), POPUP_POST_CLICK_SETTLE_TIMEOUT_MS);
      };
      if (signal?.aborted) {
        fail(new AppError("CANCELLED", "The browser action was cancelled."));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      page.on("popup", onPopup);
      page.on("close", onPageClose);
      browser.on("targetcreated", onTargetCreated);
      // The click completion promise is resolved by openLinkInNewTab in a
      // finally block, so even a failed/cancelled click cannot leave this
      // watcher alive. Events arriving during the grace period remain
      // associated with this source page.
      clickCompleted?.then(armPostClickTimer, armPostClickTimer).catch(() => undefined);
    });
  }

  private async waitForPageReady(page: Page, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await page.waitForNetworkIdle({ idleTime: 100, timeout: Math.min(this.config.browser.actionTimeoutMs, 1_000), signal }).catch((error: unknown) => {
      throwIfAborted(signal);
      if (!isPuppeteerTimeoutError(error)) {
        throw normalizeBrowserOperationError(error, signal);
      }
      return undefined;
    });
    throwIfAborted(signal);
  }

  private async waitForDocumentReady(page: Page, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      await page.waitForFunction(() => document.readyState !== "loading", { timeout: NAVIGATION_CLICK_READY_TIMEOUT_MS, signal });
    } catch (error) {
      // A document that keeps loading is still a valid result of a click. The
      // navigation event and request guard already establish the URL/policy
      // boundary; callers can explicitly wait for a selector or network idle
      // when they need stronger page readiness.
      if (isPuppeteerTimeoutError(error)) {
        throwIfAborted(signal);
        return;
      }
      throw normalizeBrowserOperationError(error, signal);
    }
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
      throw new AppError("WAIT_TIMEOUT", `The URL did not match '${pattern}' within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs } });
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
      const timer = setTimeout(() => finish(() => reject(new AppError("WAIT_TIMEOUT", `The URL did not match '${pattern}' within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs } }))), timeoutMs);
      page.on("framenavigated", onNavigated);
      signal?.addEventListener("abort", onAbort, { once: true });
      onNavigated();
    });
  }

  private async clickTarget(state: PageState, target: string, button: "left" | "middle" | "right", clickCount: number, signal?: AbortSignal, frame: Frame = state.page.mainFrame(), pointerType: "mouse" | "touch" = "mouse"): Promise<ClickMonitorResult> {
    let selector: string | undefined;
    let clickDescriptor: (ClickDescriptor & { href?: string; rect: { x: number; y: number; width: number; height: number } }) | undefined;
    const normalizedTarget = target.trim();
    const ref = normalizedTarget.startsWith("ref:") ? normalizedTarget.slice(4) : normalizedTarget;
    if (/^e\d+$/.test(ref)) {
      const resolved = await this.clickSnapshotRef(state, normalizedTarget, frame);
      selector = resolved.selector;
      clickDescriptor = resolved.descriptor;
    } else {
      selector = normalizedTarget;
      try {
        clickDescriptor = await this.clickDescriptorForSelector(frame, selector);
      } catch (error) {
        if (isMissingElementError(error)) {
          selector = undefined;
        } else if (isSelectorSyntaxError(error)) {
          if (looksLikeExplicitSelector(normalizedTarget)) {
            throw new AppError("SELECTOR_INVALID", `The selector '${normalizedTarget.slice(0, 200)}' is invalid.`, { cause: error });
          }
          selector = undefined;
        } else {
          throw normalizeBrowserOperationError(error, signal);
        }
      }
    }
    if (selector && clickDescriptor) {
      this.assertClickTargetSafe(clickDescriptor);
      if (clickDescriptor.href) {
        await this.assertNavigationUrl(frame.url() || state.page.url(), clickDescriptor.href);
      }
      return this.clickElement(state, frame, selector, button, clickCount, signal, Boolean(clickDescriptor.href), /^e\d+$/.test(ref) ? normalizedTarget : undefined, pointerType);
    }
    if (button !== "left") {
      throw new AppError("INVALID_ACTION", "Exact visible-text clicks support only the left mouse button; use a selector or coordinates for other buttons.");
    }
    const targetHandle = await frame.evaluateHandle((needle, maxNodes) => {
      const normalizedTarget = needle.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
      if (!normalizedTarget || !document.body) return null;
      const hiddenTags = new Set(["script", "style", "noscript", "template"]);
      const boundedText = (root: Element): string => {
        const maybeChildNodes = (root as unknown as { childNodes?: unknown }).childNodes;
        if (!maybeChildNodes) return String((root as unknown as { textContent?: unknown }).textContent ?? "").slice(0, 2_000);
        const stack: Node[] = [root];
        let output = "";
        let visited = 0;
        while (stack.length > 0 && output.length < 2_000) {
          const node = stack.pop();
          if (!node) break;
          visited += 1;
          if (visited > 2_000) break;
          if (node.nodeType === 3) {
            output += (node.nodeValue ?? "").slice(0, 2_000 - output.length);
            continue;
          }
          if (node.nodeType !== 1) continue;
          const children = (node as Element).childNodes;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) stack.push(child);
          }
        }
        return output.slice(0, 2_000);
      };
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      };
      // Check descendants before their containers. This preserves the old
      // reverse-descendant preference (important for SVG containers whose
      // aggregate text matches a smaller text node) without materializing a
      // selector result for the whole body.
      const stack: Array<{ element: Element; hidden: boolean; afterChildren: boolean }> = [{ element: document.body, hidden: false, afterChildren: false }];
      let visited = 0;
      while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry) break;
        if (!entry.afterChildren) {
          visited += 1;
          if (visited > maxNodes) break;
        }
        const { element, hidden, afterChildren } = entry;
        const tag = element.tagName.toLowerCase();
        if (hiddenTags.has(tag)) continue;
        const style = element.getAttribute("style") ?? "";
        const locallyHidden = hidden
          || element.hasAttribute("hidden")
          || element.getAttribute("aria-hidden") === "true"
          || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
        if (element !== document.body && !locallyHidden && afterChildren) {
          const isClickable = Boolean(element.closest("a,button,input,select,textarea,[role=button],[onclick]")) || typeof SVGElement !== "undefined" && element instanceof SVGElement;
          // Leaf nodes cover the normal exact-text path without repeatedly
          // reading a large ancestor's text. Small clickable containers cover
          // labels split across a handful of inline children.
          if (element.children.length === 0 || (isClickable && element.children.length <= 8)) {
            const candidateText = boundedText(element).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
            if (candidateText === normalizedTarget) {
              const clickable = element.closest("a,button,input,select,textarea,[role=button],[onclick]");
              if ((clickable && isVisible(clickable)) || (!clickable && typeof SVGElement !== "undefined" && element instanceof SVGElement && isVisible(element))) {
                // MiniWoB++ uses SVG text/shapes with listeners attached by
                // D3 rather than semantic HTML controls. Preserve exact-text
                // matching but allow an SVG target without an HTML ancestor.
                return clickable ?? (typeof SVGElement !== "undefined" && element instanceof SVGElement ? element : null);
              }
            }
          }
        }
        if (afterChildren) continue;
        const children = element.children;
        stack.push({ element, hidden: locallyHidden, afterChildren: true });
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child) stack.push({ element: child, hidden: locallyHidden, afterChildren: false });
        }
      }
      return null;
    }, target, MAX_DOM_TRAVERSAL_NODES);
    const clickable = targetHandle.asElement() as ElementHandle<Element> | null;
    if (!clickable) {
      await targetHandle.dispose().catch(() => undefined);
      throw new AppError("ELEMENT_NOT_FOUND", `No clickable element matched '${target.slice(0, 200)}'.`);
    }
    try {
      const targetDescriptor = await clickable.evaluate((element) => {
        const htmlElement = element as HTMLElement & { type?: string; value?: string };
        const anchor = element.closest("a") as HTMLAnchorElement | null;
        const rect = element.getBoundingClientRect();
        const stack: Node[] = [element];
        let labelText = "";
        let visited = 0;
        while (stack.length > 0 && labelText.length < 200) {
          const node = stack.pop();
          if (!node) break;
          visited += 1;
          if (visited > 512) break;
          if (node.nodeType === 3) {
            labelText += (node.nodeValue ?? "").slice(0, 200 - labelText.length);
            continue;
          }
          if (node.nodeType !== 1) continue;
          const current = node as Element;
          if (["script", "style", "noscript", "template"].includes(current.tagName.toLowerCase())) continue;
          const children = current.childNodes;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) stack.push(child);
          }
        }
        return {
          width: rect.width,
          height: rect.height,
          tag: element.tagName.toLowerCase(),
          type: htmlElement.type?.toLowerCase() ?? "",
          role: element.getAttribute("role") ?? "",
          label: [labelText, element.getAttribute("aria-label"), element.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
          href: anchor?.href ?? element.getAttribute("href") ?? undefined,
        };
      });
      if (targetDescriptor.width <= 0 || targetDescriptor.height <= 0) {
        throw new AppError("ELEMENT_NOT_FOUND", `No clickable element matched '${target.slice(0, 200)}'.`);
      }
      this.assertClickTargetSafe(targetDescriptor);
      if (targetDescriptor.href) {
        await this.assertNavigationUrl(frame.url() || state.page.url(), targetDescriptor.href);
      }
      const monitor = await this.runClickAndMonitor(state.page, async () => {
        if (pointerType === "touch") {
          if (frame !== state.page.mainFrame()) {
            throw new AppError("FRAME_ACTION_UNSUPPORTED", "Touch clicks target the top-level viewport; use a selector or coordinates for a child frame.");
          }
          const point = await this.touchPoint(clickable);
          await this.touchTap(state.page, point.x, point.y, signal);
          return;
        }
        await clickable.click({ button: "left", count: clickCount });
      }, signal, Boolean(targetDescriptor.href), frame);
      await this.throwPendingNavigationError(state, signal);
      return monitor;
    } finally {
      await targetHandle.dispose().catch(() => undefined);
    }
  }

  private async clickDescriptorForSelector(frame: Frame, selector: string): Promise<ClickDescriptor & { href?: string; rect: { x: number; y: number; width: number; height: number } }> {
    return frame.$eval(selector, (element) => {
      const clickable = element.closest("a,button,input,select,textarea,[role=button]") ?? element;
      const htmlElement = clickable as HTMLElement & { type?: string; value?: string };
      const anchor = clickable.closest("a") as HTMLAnchorElement | null;
      const stack: Node[] = [clickable];
      let labelText = "";
      let visited = 0;
      while (stack.length > 0 && labelText.length < 200) {
        const node = stack.pop();
        if (!node) break;
        visited += 1;
        if (visited > 512) break;
        if (node.nodeType === 3) {
          labelText += (node.nodeValue ?? "").slice(0, 200 - labelText.length);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const current = node as Element;
        if (["script", "style", "noscript", "template"].includes(current.tagName.toLowerCase())) continue;
        const children = current.childNodes;
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child) stack.push(child);
        }
      }
      return {
        tag: clickable.tagName.toLowerCase(),
        type: htmlElement.type?.toLowerCase() ?? "",
        role: clickable.getAttribute("role") ?? "",
        focusable: clickable instanceof HTMLElement && (clickable.hasAttribute("tabindex") || /^(?:button|input|select|textarea|a)$/i.test(clickable.tagName)),
        label: [labelText, clickable.getAttribute("aria-label"), clickable.getAttribute("title"), htmlElement.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
        href: anchor?.href ?? (clickable as HTMLAnchorElement).href ?? clickable.getAttribute("href") ?? undefined,
        rect: (() => {
          const rect = clickable.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })(),
      };
    });
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

  private assertClickGeometry(target: ClickDescriptor & { rect: { width: number; height: number } }): void {
    if ((target.rect.width <= 0 || target.rect.height <= 0) && !target.focusable) {
      throw new AppError("ELEMENT_NOT_VISIBLE", "The browser target is not visible or cannot be clicked in the current viewport.", { retryable: true });
    }
  }

  private async clickElement(state: PageState, frame: Frame, selector: string, button: "left" | "middle" | "right", clickCount: number, signal?: AbortSignal, expectNavigation = false, expectedRef?: string, pointerType: "mouse" | "touch" = "mouse"): Promise<ClickMonitorResult> {
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
    // Resolve and scroll the element immediately before the real click. A
    // snapshot or descriptor may have been collected before a layout shift or
    // animation; remeasuring the live node lets Puppeteer calculate a current
    // clickable point. Element refs are revalidated on every retry so this
    // cannot turn a stale identity check into a selector-only click.
    const prepare = async (): Promise<boolean> => {
      const initial = expectedRef
        ? (await this.clickSnapshotRef(state, expectedRef, frame)).descriptor
        : await this.clickDescriptorForSelector(frame, selector);
      this.assertClickTargetSafe(initial);
      this.assertClickGeometry(initial);
      if (initial.href) {
        await this.assertNavigationUrl(frame.url() || state.page.url(), initial.href);
      }
      if ((initial.rect.width <= 0 || initial.rect.height <= 0) && initial.focusable) {
        await frame.$eval(selector, (element) => {
          if (element instanceof HTMLElement) {
            element.focus();
          }
        });
        return true;
      }
      const targetHandle = await frame.$(selector);
      if (!targetHandle) {
        throw new AppError("ELEMENT_NOT_FOUND", "The requested browser element was not found.");
      }
      try {
        const scrollIntoView = (targetHandle as unknown as { scrollIntoView?: () => Promise<void> }).scrollIntoView;
        if (scrollIntoView) {
          await scrollIntoView.call(targetHandle);
        }
      } finally {
        await targetHandle.dispose().catch(() => undefined);
      }
      const current = expectedRef
        ? (await this.clickSnapshotRef(state, expectedRef, frame)).descriptor
        : await this.clickDescriptorForSelector(frame, selector);
      this.assertClickTargetSafe(current);
      this.assertClickGeometry(current);
      if (current.href) {
        await this.assertNavigationUrl(frame.url() || state.page.url(), current.href);
      }
      if ((current.rect.width <= 0 || current.rect.height <= 0) && current.focusable) {
        await frame.$eval(selector, (element) => {
          if (element instanceof HTMLElement) {
            element.focus();
          }
        });
        return true;
      }
      return false;
    };
    const pageMainFrame = typeof state.page.mainFrame === "function" ? state.page.mainFrame() : undefined;
    const trigger = async (): Promise<void> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < CLICK_RETRY_ATTEMPTS; attempt += 1) {
        try {
          throwIfAborted(signal);
          const focused = await prepare();
          if (focused) {
            return;
          }
          if (pointerType === "touch") {
            if (pageMainFrame && frame !== pageMainFrame) {
              throw new AppError("FRAME_ACTION_UNSUPPORTED", "Touch clicks target the top-level viewport; use a selector or coordinates for a child frame.");
            }
            const targetHandle = await frame.$(selector);
            if (!targetHandle) {
              throw new AppError("ELEMENT_NOT_FOUND", "The requested browser element was not found.");
            }
            try {
              const point = await this.touchPoint(targetHandle);
              await this.touchTap(state.page, point.x, point.y, signal);
            } finally {
              await targetHandle.dispose().catch(() => undefined);
            }
          } else if (pageMainFrame && frame === pageMainFrame) {
            const targetHandle = await frame.$(selector);
            if (!targetHandle) {
              throw new AppError("ELEMENT_NOT_FOUND", "The requested browser element was not found.");
            }
            try {
              const clickablePoint = (targetHandle as unknown as { clickablePoint?: () => Promise<{ x: number; y: number }> }).clickablePoint;
              if (!clickablePoint && typeof (targetHandle as unknown as { boundingBox?: unknown }).boundingBox !== "function") {
                // Lightweight test doubles and older Puppeteer handles may
                // expose selector clicking without geometry helpers. Keep the
                // validated selector path available for those adapters.
                await frame.click(selector, { button, count: clickCount });
                return;
              }
              const svgPoint = await this.svgHitTestPoint(targetHandle);
              const point = svgPoint ?? (clickablePoint
                ? await clickablePoint.call(targetHandle)
                : await (async () => {
                  const bounds = await targetHandle.boundingBox();
                  if (!bounds) {
                    throw new AppError("ELEMENT_NOT_FOUND", "The requested browser element is detached or not visible.");
                  }
                  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
                })());
              await this.mouseClick(state.page, point.x, point.y, button, clickCount, signal);
            } finally {
              await targetHandle.dispose().catch(() => undefined);
            }
          } else {
            await frame.click(selector, { button, count: clickCount });
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt + 1 >= CLICK_RETRY_ATTEMPTS || !isTransientClickError(error)) {
            throw error;
          }
          await wait(CLICK_RETRY_DELAY_MS, signal);
        }
      }
      throw lastError;
    };
    const click = this.runClickAndMonitor(state.page, trigger, signal, expectNavigation, frame).then(
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

  private async runClickAndMonitor(page: Page, trigger: () => Promise<void>, signal?: AbortSignal, expectNavigation = true, navigationFrame?: Frame): Promise<ClickMonitorResult> {
    throwIfAborted(signal);
    const beforeUrl = navigationFrame && typeof navigationFrame.url === "function" ? navigationFrame.url() : typeof page.url === "function" ? page.url() : "";
    let navigated = false;
    let resolveNavigation!: () => void;
    const navigationObserved = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    const onFrameNavigated = (frame: Frame): void => {
      try {
        if (frame === (navigationFrame ?? page.mainFrame())) {
          navigated = true;
          resolveNavigation();
        }
      } catch {
        // Page disposal can race the navigation event; the click operation
        // will report its own lifecycle/cancellation result.
      }
    };
    page.on("framenavigated", onFrameNavigated);
    try {
      await trigger();
      // Puppeteer resolves the click promise before every navigation event is
      // necessarily delivered. Keep the settle window before classifying the
      // click so redirects and client-side navigation are not misreported.
      await wait(expectNavigation ? NAVIGATION_CLICK_SETTLE_TIMEOUT_MS : CLICK_SETTLE_TIMEOUT_MS, signal);
      if (expectNavigation && !navigated) {
        await awaitWithAbort(settleWithTimeout(navigationObserved, NAVIGATION_CLICK_EVENT_TIMEOUT_MS), signal);
      }
      if (navigated) {
        await this.waitForDocumentReady(navigationFrame ? navigationFrame as unknown as Page : page, signal);
      }
      const url = navigationFrame && typeof navigationFrame.url === "function" ? navigationFrame.url() : typeof page.url === "function" ? page.url() : "";
      return { navigated, urlChanged: url !== beforeUrl, url };
    } catch (error) {
      throw normalizeBrowserOperationError(error, signal);
    } finally {
      page.off("framenavigated", onFrameNavigated);
    }
  }

  private async assertCurrentPageAllowed(page: Page, state?: PageState): Promise<void> {
    const url = page.url();
    if (!state) {
      if (url !== "about:blank") {
        await this.policy.assertNavigationAllowedAsync(url);
      }
      return;
    }
    await this.assertFrameUrlAllowed(state, url);
  }

  /**
   * Revalidate the URL syntax/domain policy on every call, but avoid repeating
   * DNS for the exact document/frame URL already admitted for this PageState.
   * The CDP request guard still performs asynchronous checks for every new
   * browser request, so this cache cannot authorize a later redirect or fetch.
   */
  private async assertFrameUrlAllowed(state: PageState, rawUrl: string): Promise<void> {
    if (rawUrl === "about:blank") {
      return;
    }
    const normalized = this.policy.assertNavigationAllowed(rawUrl).toString();
    state.policyVerifiedUrls ??= new Set();
    if (state.policyVerifiedUrls.has(normalized)) {
      return;
    }
    await this.policy.assertNavigationAllowedAsync(normalized);
    state.policyVerifiedUrls.add(normalized);
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
    try {
      const base = new URL(baseUrl);
      if (base.origin === resolved.origin && (base.protocol === "http:" || base.protocol === "https:")) {
        // The current document already passed the asynchronous DNS policy
        // gate. Same-origin link checks still enforce the synchronous domain,
        // scheme, credential, and allowlist rules here; the request
        // interception guard re-checks the actual navigation (including
        // redirects) asynchronously at the CDP boundary. Avoiding a second
        // DNS lookup removes a large fixed cost from ordinary public links.
        return this.policy.assertNavigationAllowed(resolved.toString());
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
    }
    return this.policy.assertNavigationAllowedAsync(resolved.toString());
  }

  private beginNavigation(state: PageState): number {
    const generation = state.navigationGeneration + 1;
    state.navigationGeneration = generation;
    state.activeNavigationGeneration = generation;
    state.navigationError = undefined;
    state.mainFrameStatus = undefined;
    this.clearTargetGuardNavigationError(state.page);
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
    const error = this.takeNavigationError(state, generation) ?? this.takeTargetGuardNavigationError(state.page);
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
    const selector = await this.selectorFor(state, target, framePath(frame), frame);
    const input = await frame.$(selector);
    if (!input) {
      throw new AppError("ELEMENT_NOT_FOUND", `No input matched '${target.slice(0, 200)}'.`);
    }
    try {
      throwIfAborted(signal);
      await input.focus();
      throwIfAborted(signal);
      // Chromium's keyboard path edits date/time controls as segmented fields;
      // typing an ISO value can therefore produce a different value. Number
      // controls can likewise retain the old value when a CDP select-all is
      // delivered while the control is focused. Use bounded native setters
      // only for validated replacement values; all other inputs retain the
      // normal trusted keyboard path. These callbacks are not exposed as
      // arbitrary page evaluation.
      const nativeControlValueSet = clear && (
        await this.setNativeTemporalInputValue(input, text, signal)
        || await this.setNativeNumberInputValue(input, text, signal)
      );
      if (!nativeControlValueSet && clear) {
        throwIfAborted(signal);
        const modifier = platform === "darwin" ? "Meta" : "Control";
        await state.page.keyboard.down(modifier);
        try {
          throwIfAborted(signal);
          await state.page.keyboard.press("A");
          // Selecting all is not itself a mutation. Backspace commits the
          // deletion (and the browser's normal input event) even when the new
          // text is the empty string.
          throwIfAborted(signal);
          await state.page.keyboard.press("Backspace");
        } finally {
          await state.page.keyboard.up(modifier).catch(() => undefined);
        }
      }
      if (!nativeControlValueSet) {
        throwIfAborted(signal);
        await state.page.keyboard.type(text);
      }
      throwIfAborted(signal);
      if (!verify) {
        return {};
      }
      const value = await input.evaluate((element) => {
        const htmlElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        if ("value" in htmlElement) {
          return String(htmlElement.value).slice(0, 16_384);
        }
        const stack: Node[] = [element];
        let text = "";
        let visited = 0;
        while (stack.length > 0 && text.length < 16_384) {
          const node = stack.pop();
          if (!node) break;
          visited += 1;
          if (visited > 4_096) break;
          if (node.nodeType === 3) {
            text += (node.nodeValue ?? "").slice(0, 16_384 - text.length);
            continue;
          }
          if (node.nodeType !== 1) continue;
          const children = (node as Element).childNodes;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) stack.push(child);
          }
        }
        return text;
      });
      return { verified: clear ? value === text : value.endsWith(text) };
    } finally {
      await input.dispose().catch(() => undefined);
    }
  }

  private async setNativeTemporalInputValue(input: ElementHandle<Element>, text: string, signal?: AbortSignal): Promise<boolean> {
    const inputType = await input.evaluate((element) => (
      element instanceof HTMLInputElement ? element.type.toLowerCase() : ""
    ));
    if (!isCanonicalNativeTemporalInputValue(inputType, text)) {
      return false;
    }
    throwIfAborted(signal);
    await input.evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement)) {
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) {
        throw new Error("The native input value setter is unavailable.");
      }
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
    throwIfAborted(signal);
    return true;
  }

  private async setNativeNumberInputValue(input: ElementHandle<Element>, text: string, signal?: AbortSignal): Promise<boolean> {
    const inputType = await input.evaluate((element) => (
      element instanceof HTMLInputElement ? element.type.toLowerCase() : ""
    ));
    if (inputType !== "number" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
      return false;
    }
    throwIfAborted(signal);
    await input.evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement)) {
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) {
        throw new Error("The native input value setter is unavailable.");
      }
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
    throwIfAborted(signal);
    return true;
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
            // A CDP key-down can be delivered before Puppeteer reports a
            // transport error. Record the attempted modifier first so the
            // cleanup path always sends the matching key-up.
            pressed.push(modifier);
            await page.keyboard.down(normalizeKeyInput(modifier));
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
        throwIfAborted(signal);
      } else {
        await page.keyboard.press(normalizeKeyInput(key));
        throwIfAborted(signal);
      }
    }
  }

  private async touchTap(page: Page, x: number, y: number, signal?: AbortSignal): Promise<void> {
    // Use Puppeteer's page-owned touchscreen so the start/end packets share
    // the same rounded point, pressure, radius, modifiers, and active-touch
    // bookkeeping as the rest of the input stack. A hand-built CDP packet
    // with an empty touchEnd can be hit-tested against a different target in
    // Chromium, especially for SVG and nested scrolling controls.
    throwIfAborted(signal);
    await page.touchscreen.tap(x, y);
    throwIfAborted(signal);
  }

  private async mouseClick(page: Page, x: number, y: number, button: "left" | "middle" | "right", count: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Puppeteer's convenience click queues move/down/up together. On a
    // connected page that can synthesize the initial down against the old
    // pointer target, which is observable on empty inline controls. Keep the
    // sequence explicit so every event is delivered at the requested point.
    await page.mouse.move(x, y);
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      throwIfAborted(signal);
      let pressed = false;
      try {
        await page.mouse.down({ button, clickCount } as unknown as { button: "left" | "middle" | "right" });
        pressed = true;
      } finally {
        if (pressed) {
          await page.mouse.up({ button, clickCount } as unknown as { button: "left" | "middle" | "right" }).catch(() => undefined);
        }
      }
    }
  }

  private async touchPoint(handle: ElementHandle<Element>): Promise<{ x: number; y: number }> {
    const bounds = await handle.boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new AppError("ELEMENT_NOT_VISIBLE", "The touch target is not visible.", { retryable: true });
    }
    // A few SVG and replaced-inline controls put a transparent descendant at
    // the geometric center. A point just inside the lower edge remains inside
    // the target while reaching the target's own pointer hit region.
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + Math.max(0.5, bounds.height - 1),
    };
  }

  private async svgHitTestPoint(handle: ElementHandle<Element>): Promise<{ x: number; y: number } | undefined> {
    if (typeof (handle as unknown as { evaluate?: unknown }).evaluate !== "function") return undefined;
    return handle.evaluate((element) => {
      if (!(element instanceof SVGElement)) return undefined;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      const candidates = [
        [0.5, 0.5], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5],
        [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
        [0.35, 0.65], [0.65, 0.65], [0.35, 0.35], [0.65, 0.35],
      ];
      for (const [xRatio, yRatio] of candidates) {
        const x = rect.x + rect.width * xRatio;
        const y = rect.y + rect.height * yRatio;
        const hit = document.elementFromPoint(x, y);
        if (hit === element || (hit && element.contains(hit))) return { x, y };
      }
      return undefined;
    });
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
    if (previous) {
      await awaitWithAbort(previous, signal);
    }
    throwIfAborted(signal);
    const pending = state.dialogs[0];
    if (!pending) {
      throw new AppError("DIALOG_NOT_FOUND", "No JavaScript dialog is currently open.");
    }

    let settled = false;
    const resolution = Promise.resolve().then(async () => {
      if (accept) {
        await pending.dialog.accept(text);
      } else {
        await pending.dialog.dismiss();
      }
    }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    // Keep a rejection handler attached even when the caller cancels before
    // Chromium settles the underlying dialog command.
    const tracked = resolution.then(() => undefined, () => undefined);
    state.dialogResolutionPromise = tracked;
    try {
      await awaitWithAbort(resolution, signal);
      return { resolved: true, type: pending.type, accepted: accept };
    } finally {
      const clearPending = (): void => {
        // A cancelled resolution may still be in flight. Keep the dialog
        // blocking and serialize the next resolution until that command has
        // actually settled.
        if (state.dialogs[0] === pending) {
          state.dialogs.shift();
        }
        if (state.dialogResolutionPromise === tracked) {
          state.dialogResolutionPromise = undefined;
        }
      };
      if (settled) {
        clearPending();
      } else {
        void tracked.then(clearPending);
      }
    }
  }

  private async detectChallenge(state: PageState, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    try {
      const evidence = await awaitWithAbort(state.page.evaluate((limits: { maxNodes: number; textChars: number; htmlChars: number }) => {
        const hiddenTags = new Set(["script", "style", "noscript", "template"]);
        const boundedText = (root: Node | null): string => {
          if (!root) return "";
          const stack: Array<{ node: Node; hidden: boolean }> = [{ node: root, hidden: false }];
          let output = "";
          let visited = 0;
          while (stack.length > 0 && output.length < limits.textChars) {
            const entry = stack.pop();
            if (!entry) break;
            visited += 1;
            if (visited > limits.maxNodes) break;
            if (entry.node.nodeType === 3) {
              if (!entry.hidden) output += (entry.node.nodeValue ?? "").slice(0, limits.textChars - output.length);
              continue;
            }
            if (entry.node.nodeType !== 1) continue;
            const element = entry.node as Element;
            const tag = element.tagName.toLowerCase();
            if (hiddenTags.has(tag)) continue;
            const style = element.getAttribute("style") ?? "";
            const locallyHidden = entry.hidden
              || element.hasAttribute("hidden")
              || element.getAttribute("aria-hidden") === "true"
              || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
            const children = element.childNodes;
            for (let index = children.length - 1; index >= 0; index -= 1) {
              const child = children[index];
              if (child) stack.push({ node: child, hidden: locallyHidden });
            }
          }
          return output.slice(0, limits.textChars);
        };
        const htmlParts: string[] = [];
        const frameSources: string[] = [];
        const visibleMarkers: string[] = [];
        let htmlLength = 0;
        const appendMarkup = (value: string): void => {
          if (htmlLength >= limits.htmlChars) return;
          const remaining = limits.htmlChars - htmlLength;
          const part = value.slice(0, remaining);
          htmlParts.push(part);
          htmlLength += part.length;
        };
        const root = document.documentElement;
        const stack: Array<{ element: Element; hidden: boolean }> = root ? [{ element: root, hidden: false }] : [];
        let visited = 0;
        while (stack.length > 0) {
          const entry = stack.pop();
          if (!entry) break;
          visited += 1;
          if (visited > limits.maxNodes) break;
          const { element, hidden } = entry;
          const tag = element.tagName.toLowerCase();
          if (hiddenTags.has(tag)) continue;
          const style = element.getAttribute("style") ?? "";
          const locallyHidden = hidden
            || element.hasAttribute("hidden")
            || element.getAttribute("aria-hidden") === "true"
            || /(?:^|[;\s])(display|visibility)\s*:\s*(?:none|hidden)\b|(?:^|[;\s])opacity\s*:\s*0(?:[;\s]|$)/i.test(style);
          const id = element.getAttribute("id") ?? "";
          const className = element.getAttribute("class") ?? "";
          const name = element.getAttribute("name") ?? "";
          const src = element.getAttribute("src") ?? "";
          const siteKey = element.getAttribute("data-sitekey") ?? "";
          appendMarkup(`<${tag} id="${id.slice(0, 500)}" class="${className.slice(0, 2_000)}" name="${name.slice(0, 500)}" src="${src.slice(0, 4_096)}" data-sitekey="${siteKey.slice(0, 1_000)}">`);
          if (tag === "iframe" && src && frameSources.length < 100) {
            frameSources.push(src.slice(0, 4_096));
          }
          if (!locallyHidden && ["iframe", "form", "div", "section"].includes(tag) && visibleMarkers.length < 200) {
            const rect = (element as HTMLElement).getBoundingClientRect();
            const computed = window.getComputedStyle(element);
            if (rect.width > 0 && rect.height > 0 && computed.display !== "none" && computed.visibility !== "hidden") {
              visibleMarkers.push([element.tagName, id, className, name, src, siteKey].filter(Boolean).join(" ").slice(0, 4_000));
            }
          }
          const children = element.children;
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child) stack.push({ element: child, hidden: locallyHidden });
          }
        }
        return {
          title: document.title.slice(0, 8_000),
          text: boundedText(document.body),
          html: htmlParts.join("").slice(0, limits.htmlChars),
          frameSources,
          visibleMarkers,
        };
      }, { maxNodes: MAX_DOM_TRAVERSAL_NODES, textChars: 100_000, htmlChars: MAX_MARKUP_EVIDENCE_CHARS }), signal);
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
    const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
    const boundedPollMs = Number.isFinite(pollMs) ? Math.max(1, Math.floor(pollMs)) : 1_000;
    const deadline = startedAt + boundedTimeoutMs;
    throwIfAborted(signal);
    const initial = await this.detectChallenge(state, signal);
    let last: unknown = initial;
    if (isChallengeUnknown(initial)) {
      return { status: "unverified", resolution: "challenge_state_unverified", pageId: state.id, waitedMs: 0, initial, final: initial };
    }
    if (isChallengeAbsent(initial)) {
      return { status: "resolved", resolution: "no_challenge_at_start", pageId: state.id, waitedMs: 0, initial, final: initial };
    }
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      last = await this.detectChallenge(state, signal);
      if (isChallengeUnknown(last)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await wait(Math.min(boundedPollMs, remaining), signal);
        continue;
      }
      if (isChallengeAbsent(last)) {
        return { status: "resolved", resolution: "challenge_cleared", pageId: state.id, waitedMs: Date.now() - startedAt, initial, final: last };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(boundedPollMs, remaining), signal);
    }
    return { status: "timed_out", resolution: "timeout", pageId: state.id, waitedMs: Math.max(0, Date.now() - startedAt), initial, final: last };
  }

  private async listDownloads(signal?: AbortSignal): Promise<unknown> {
    const downloadDir = resolve(this.config.dataDir, "downloads");
    try {
      throwIfAborted(signal);
      const entries = await awaitWithAbort(readdir(downloadDir, { withFileTypes: true }), signal);
      const candidates = entries
        .filter((entry) => entry.isFile())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_DOWNLOAD_ENTRIES);
      const listed: Array<Record<string, unknown>> = [];
      for (const entry of candidates) {
        throwIfAborted(signal);
        const filePath = join(downloadDir, entry.name);
        try {
          const fileStat = await awaitWithAbort(stat(filePath), signal);
          const partial = /\.(?:crdownload|part|tmp)$/i.test(entry.name);
          const relativePath = await awaitWithAbort(this.serverRelativePath(filePath), signal);
          listed.push({
            name: wrapUntrustedText("download_name", redactSecretPlaceholders(entry.name), 512),
            path: wrapUntrustedText("download_path", redactSecretPlaceholders(relativePath), 1_024),
            size: Math.min(fileStat.size, Number.MAX_SAFE_INTEGER),
            extension: wrapUntrustedText("download_extension", redactSecretPlaceholders(extname(entry.name).slice(1, 128)), 128),
            modifiedAt: wrapUntrustedText("download_modified_at", redactSecretPlaceholders(fileStat.mtime.toISOString()), 128),
            status: partial ? "in_progress" : "complete",
          });
        } catch (error) {
          if (isMissingFile(error)) {
            continue;
          }
          throw error;
        }
      }
      throwIfAborted(signal);
      return listed;
    } catch (error) {
      throwIfAborted(signal);
      if (isMissingFile(error)) {
        return [];
      }
      if (error instanceof AppError && error.code === "DOWNLOADS_UNAVAILABLE") {
        throw error;
      }
      throw new AppError("DOWNLOADS_UNAVAILABLE", "Downloaded files could not be listed. Verify the browser download directory and retry.", { retryable: true, cause: error });
    }
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

  private async withOperationLock<T>(signal: AbortSignal | undefined, operation: (operationSignal: AbortSignal) => Promise<T>, queueTimeoutMs = this.config.browser.actionTimeoutMs, operationTimeoutMs?: number, mode: "exclusive" | "read" = "exclusive"): Promise<T> {
    if (this.queuedOperations >= MAX_QUEUED_OPERATIONS) {
      throw new AppError("BROWSER_QUEUE_FULL", "The browser action queue is full; wait for an active operation to finish and retry.", { retryable: true, details: { hint: "Wait for the active browser operation to finish, then retry." } });
    }
    this.queuedOperations += 1;
    const readMode = mode === "read";
    const requestSessionGeneration = this.sessionGeneration;
    const requestStartedAt = Date.now();
    const previous = this.operationTail;
    const readDrain = this.readDrainPromise;
    let release!: () => void;
    if (!readMode) {
      this.operationTail = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
    }
    const queueSignal = combineSignals(signal, this.shutdownController.signal);
    let acquired = false;
    let deferRelease = false;
    let operationPromise: Promise<T> | undefined;
    try {
      if (readMode) {
        while (true) {
          const readTurn = this.operationTail;
          await waitForTurn(readTurn, queueSignal, queueTimeoutMs);
          if (readTurn !== this.operationTail) {
            continue;
          }
          await this.acquireReadPermit(queueSignal, queueTimeoutMs);
          // A writer may publish a queue node while this read waits for a
          // permit. Do not let that reader overtake the writer; hand the
          // permit back and re-enter behind the writer instead.
          if (readTurn !== this.operationTail) {
            this.endReadOperation();
            continue;
          }
          break;
        }
      } else {
        await waitForTurn(previous, queueSignal, queueTimeoutMs);
        await waitForTurn(readDrain, queueSignal, queueTimeoutMs);
      }
      acquired = true;
      throwIfAborted(queueSignal);
      if (requestSessionGeneration !== this.sessionGeneration) {
        throw new AppError("SESSION_CLOSED", "The browser session was closed before this operation started.", { retryable: true });
      }
      const operationController = new AbortController();
      this.activeOperationControllers.add(operationController);
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
            ? new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } })
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
            rejectAbort(new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) } }));
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
          throw new AppError("BROWSER_TIMEOUT", `The browser operation exceeded its ${Math.max(1, Math.floor(operationTimeoutMs ?? 0))}ms action deadline.`, { retryable: true, details: { phase: "action", timeoutMs: Math.max(1, Math.floor(operationTimeoutMs ?? 0)) }, cause: error });
        }
        throw normalized;
      } finally {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
        removeAbortListener?.();
        this.activeOperationControllers.delete(operationController);
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
      if (readMode) {
        if (acquired) {
          this.endReadOperation();
        }
      } else {
        if (acquired) {
          if (!deferRelease) {
            release();
          }
        } else {
          void Promise.all([previous, readDrain]).then(release, release);
        }
      }
    }
  }

  private beginReadOperation(): void {
    if (this.activeReadOperations === 0) {
      this.readDrainPromise = new Promise<void>((resolvePromise) => {
        this.readDrainRelease = resolvePromise;
      });
    }
    this.activeReadOperations += 1;
  }

  private endReadOperation(): void {
    this.activeReadOperations = Math.max(0, this.activeReadOperations - 1);
    const next = this.readPermitWaiters.shift();
    if (next) {
      next();
    } else if (this.activeReadOperations === 0) {
      this.readDrainRelease?.();
      this.readDrainRelease = undefined;
    }
  }

  private async acquireReadPermit(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    if (this.activeReadOperations < MAX_PARALLEL_READ_OPERATIONS && this.readPermitWaiters.length === 0) {
      this.beginReadOperation();
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const waiter = (): void => finish(resolvePromise);
      const removeWaiter = (): void => {
        const index = this.readPermitWaiters.indexOf(waiter);
        if (index >= 0) {
          this.readPermitWaiters.splice(index, 1);
        }
      };
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        removeWaiter();
        callback();
      };
      const onAbort = (): void => finish(() => reject(new AppError("CANCELLED", "The browser action was cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new AppError("BROWSER_QUEUE_TIMEOUT", `The browser operation waited more than ${timeoutMs}ms for a read permit.`, { retryable: true, details: { phase: "queue", timeoutMs } }))), Math.max(1, Math.floor(timeoutMs)));
      this.readPermitWaiters.push(waiter);
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    this.beginReadOperation();
  }
}

async function awaitBrowserConnection(connection: Promise<Browser>, timeoutMs: number): Promise<Browser> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = new AppError("BROWSER_CONNECT_TIMEOUT", `The browser connection did not complete within ${timeoutMs}ms.`, { retryable: true, details: { phase: "connect", timeoutMs } });
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
  await settleWithTimeout(Promise.resolve().then(() => page.close()).catch(() => undefined), 500);
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
        throw new AppError("WAIT_TIMEOUT", `The selector '${selector.slice(0, 200)}' did not become ${state} within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs, state }, cause: error });
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
      throw new AppError("WAIT_TIMEOUT", `The selector '${selector.slice(0, 200)}' did not become ${state} within ${timeoutMs}ms.`, { retryable: true, details: { phase: "wait", timeoutMs, state } });
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

function isElementVisibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:node|element) is either not visible|not an HTMLElement|element is not visible|outside (?:of )?the viewport|could not scroll into view|not clickable/i.test(message);
}

function isTransientClickError(error: unknown): boolean {
  if (error instanceof AppError && ["STALE_REFERENCE", "FRAME_MISMATCH", "USE_UPLOAD_TOOL", "USE_SELECT_TOOL", "USE_PDF_TOOL"].includes(error.code)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return isElementVisibilityError(error)
    || isMissingElementError(error)
    || /(?:detached from document|not attached to the DOM)/i.test(message);
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
  if (isElementVisibilityError(error)) {
    return new AppError("ELEMENT_NOT_VISIBLE", "The browser target is not visible or cannot be clicked in the current viewport.", { retryable: true, cause: error });
  }
  if (isMissingElementError(error)) {
    return new AppError("ELEMENT_NOT_FOUND", "The requested browser element was not found.", { cause: error });
  }
  if (isInvalidSelectorError(error)) {
    return new AppError("SELECTOR_INVALID", "The browser selector is invalid.", { cause: error });
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

function pageTargetIdentity(page: Page): { sessionId?: string; targetId?: string } {
  try {
    const target = page.target() as unknown as {
      _session?: () => CDPSession | undefined;
      _targetId?: unknown;
    };
    let sessionId: string | undefined;
    try {
      sessionId = target._session?.()?.id();
    } catch {
      sessionId = undefined;
    }
    const targetId = typeof target._targetId === "string" ? target._targetId : undefined;
    return { ...(sessionId ? { sessionId } : {}), ...(targetId ? { targetId } : {}) };
  } catch {
    return {};
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

function isCanonicalNativeTemporalInputValue(inputType: string, value: string): boolean {
  switch (inputType) {
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) {
        return false;
      }
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (year < 1 || month < 1 || month > 12 || day < 1) {
        return false;
      }
      const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      return day <= daysInMonth;
    }
    case "time":
      return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/.test(value);
    case "month": {
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
      return match !== null && Number(match[1]) >= 1;
    }
    case "week": {
      const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(value);
      if (!match) {
        return false;
      }
      const year = Number(match[1]);
      return year >= 1 && Number(match[2]) <= isoWeeksInYear(year);
    }
    default:
      return false;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isoWeeksInYear(year: number): number {
  const firstDay = new Date(0);
  firstDay.setUTCFullYear(year, 0, 1);
  firstDay.setUTCHours(0, 0, 0, 0);
  const weekday = firstDay.getUTCDay() || 7;
  return weekday === 4 || (weekday === 3 && isLeapYear(year)) ? 53 : 52;
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

function looksLikeExplicitSelector(target: string): boolean {
  const normalized = target.trim();
  return /^(?:[#.:[>+~*]|(?:pierce|aria|xpath)\/)/i.test(normalized);
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

function frameProtocolId(frame?: Frame): string | undefined {
  const id = (frame as unknown as { _id?: unknown } | undefined)?._id;
  return typeof id === "string" && id ? id : undefined;
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
      reject(new AppError("BROWSER_QUEUE_TIMEOUT", `The browser operation waited more than ${timeoutMs}ms for its turn.`, { retryable: true, details: { phase: "queue", timeoutMs } }));
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
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  if (milliseconds <= 0) {
    return;
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
