import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import type { ServerConfig } from "./config";
import type { BrowserAction, ResearchRequest } from "./contracts";
import { BrowserService, type PageSnapshot } from "./browser/service";
import { AppError, safeErrorDiagnostic } from "./errors";
import { Logger } from "./logger";
import { SecurityPolicy } from "./policy";
import { ResearchService } from "./research";
import { SERVER_VERSION } from "./version";

export class ServerRuntime {
  readonly logger: Logger;
  readonly policy: SecurityPolicy;
  readonly browser: BrowserService;
  readonly research: ResearchService;
  private closePromise?: Promise<void>;

  private constructor(readonly config: ServerConfig, private readonly browserProfileLease?: BrowserProfileLease) {
    this.logger = new Logger(config.logLevel, { component: "smooth-operator" });
    this.policy = new SecurityPolicy(config);
    this.browser = new BrowserService(config, this.policy, this.logger.child({ component: "browser" }));
    this.research = new ResearchService(this.policy, this.logger.child({ component: "research" }));
  }

  static async create(config: ServerConfig): Promise<ServerRuntime> {
    let browserProfileLease: BrowserProfileLease | undefined;
    try {
      await ensurePrivateDirectory(config.dataDir);
      await ensurePrivateDirectory(join(config.dataDir, "downloads"));
      await ensurePrivateDirectory(join(config.dataDir, "files"));
      const ownsBrowserProcess = config.browser.mode !== "disabled" && (config.browser.mode === "managed" || config.browser.mode === "launch"
        || (config.browser.autoLaunch && Boolean(config.browser.executablePath)));
      if (ownsBrowserProcess && config.browser.userDataDir) {
        await ensurePrivateDirectory(config.browser.userDataDir);
        browserProfileLease = await acquireBrowserProfileLease(config.browser.userDataDir);
      }
      const canonicalDataDir = await realpath(config.dataDir);
      const runtime = new ServerRuntime({ ...config, dataDir: canonicalDataDir }, browserProfileLease);
      runtime.logger.info("MCP runtime initialized", {
        transport: config.transport,
        browserMode: config.browser.mode,
      });
      return runtime;
    } catch (error) {
      await browserProfileLease?.release().catch(() => undefined);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("RUNTIME_INIT_FAILED", "The MCP data directories could not be initialized.", { cause: error });
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        const browserClose = await runShutdownPhase("browser close", () => this.browser.shutdownOutcome(), RUNTIME_SHUTDOWN_TIMEOUT_MS, this.logger);
        const browserOutcome = browserClose.value as { succeeded?: unknown } | undefined;
        if (browserClose.status === "complete" && browserOutcome?.succeeded !== false) {
          await runShutdownPhase("browser profile lease release", () => this.browserProfileLease?.release() ?? Promise.resolve(), PROFILE_RELEASE_TIMEOUT_MS, this.logger);
        } else if (this.browserProfileLease) {
          // Retain lock for operator recovery if browser close failed.
          await this.browserProfileLease.retain?.().catch(() => undefined);
          this.logger.warn("Retaining browser profile lease after incomplete browser shutdown");
        }
        this.logger.info("MCP runtime closed");
      })();
    }

    await this.closePromise;
  }

  async run(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
    return this.browser.execute(action, signal);
  }

  async snapshot(options: NonNullable<Parameters<BrowserService["snapshot"]>[0]>, signal?: AbortSignal): Promise<PageSnapshot> {
    return this.browser.snapshot({ ...options, signal });
  }

  async listTabs(signal?: AbortSignal): Promise<unknown> {
    return this.browser.listTabs(signal);
  }

  listSessions(): unknown {
    return [this.browser.sessionSummary()];
  }

  async browserDoctor(): Promise<Record<string, unknown>> {
    return this.browser.doctor();
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new AppError("CANCELLED", "The browser action was cancelled.");
    }
    return awaitWithAbort(this.browser.closeSession(sessionId), signal);
  }

  async webSearch(query: string, options: Omit<ResearchRequest, "query">, signal?: AbortSignal): Promise<unknown> {
    return this.research.research(query, options, signal);
  }

  publicCapabilities(): Record<string, unknown> {
    const browserDisabled = this.config.browser.mode === "disabled";
    const managedBrowser = this.config.browser.mode === "managed";
    const usesExecutable = !browserDisabled && (managedBrowser || this.config.browser.mode === "launch"
      || (this.config.browser.autoLaunch && Boolean(this.config.browser.executablePath)));
    return {
      protocol: "Model Context Protocol",
      server: { name: "SmoothOperator", version: SERVER_VERSION },
      transports: ["stdio", "http"],
      browser: {
        mode: this.config.browser.mode,
        configured: managedBrowser || (!browserDisabled
          && (usesExecutable ? Boolean(this.config.browser.executablePath) : Boolean(this.config.browser.wsEndpoint || this.config.browser.url))),
        connection: browserDisabled ? "disabled" : managedBrowser ? "managed" : usesExecutable ? "executable" : this.config.browser.wsEndpoint ? "websocket" : "devtools-http",
        runtime: browserDisabled ? { connected: false, owned: false, trackedPages: 0, queuedOperations: 0, currentPageId: null } : this.browser.connectionStatus(),
        actionTimeoutMs: this.config.browser.actionTimeoutMs,
        connectTimeoutMs: this.config.browser.connectTimeoutMs,
        cdpTimeoutMs: this.config.browser.cdpTimeoutMs,
        maxScreenshotBytes: this.config.browser.maxScreenshotBytes,
        maxHtmlChars: this.config.browser.maxHtmlChars,
      },
      security: {
        allowedDomainsConfigured: this.config.security.allowedDomains.length > 0,
        privateNetworkAllowed: this.config.security.allowPrivateNetwork,
        dnsResolution: "preflight-only; browser resolver remains unpinned",
        evaluateAllowed: this.config.security.allowEval,
        httpRemoteAllowed: this.config.http.allowRemote,
      },
      persistence: {
        fileRootsConfigured: this.config.security.allowedFileRoots.length > 0,
        state: browserDisabled ? "disabled" : usesExecutable ? "private-persistent" : "external-browser",
      },
    };
  }
}

interface BrowserProfileLease {
  release(): Promise<void>;
  retain?(): Promise<void>;
}

const BROWSER_PROFILE_LOCK_NAME = ".smooth-operator-profile.lock";
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000;
const PROFILE_RELEASE_TIMEOUT_MS = 1_000;

async function acquireBrowserProfileLease(profileDirectory: string): Promise<BrowserProfileLease> {
  const lockPath = join(resolve(profileDirectory), BROWSER_PROFILE_LOCK_NAME);
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        // Leave an unreadable/partial lock for explicit operator recovery.
        // Unlinking by pathname here could remove a replacement lock created
        // by another contender after this descriptor was opened.
        throw error;
      }

      let released = false;
      let handleClosed = false;
      return {
        retain: async () => {
          if (handleClosed) {
            return;
          }
          handleClosed = true;
          await handle.close().catch(() => undefined);
        },
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          if (!handleClosed) {
            handleClosed = true;
            await handle.close().catch(() => undefined);
          }
          const current = await readFile(lockPath, "utf8").catch(() => undefined);
          let ownsCurrentLock = false;
          if (current) {
            try {
              ownsCurrentLock = (JSON.parse(current) as { token?: unknown }).token === token;
            } catch {
              ownsCurrentLock = false;
            }
          }
          if (ownsCurrentLock) {
            await unlink(lockPath).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if (fileSystemErrorCode(error) !== "EEXIST") {
        throw new AppError("BROWSER_PROFILE_LOCK_FAILED", "The native browser profile could not be locked safely.", { cause: error });
      }
      const existing = await readProfileLock(lockPath);
      if (existing === "active") {
        throw new AppError("BROWSER_PROFILE_IN_USE", "The native browser profile is already in use by another SmoothOperator process.", { retryable: true });
      }
      if (existing === "unknown") {
        throw new AppError("BROWSER_PROFILE_LOCK_FAILED", "The native browser profile has an unreadable lock. Verify that no SmoothOperator process is using it, then remove the lock file.", { retryable: true });
      }
      if (existing === "stale") {
        // A stale lock means its owning process is provably gone (ESRCH).
        // Reclaim it by atomically moving the entry aside after re-verifying
        // identity (same inode, same dead pid) so a contender that replaced
        // the lock between our checks is never stolen from. Blind unlinking
        // by pathname would remain racy; rename keeps the swap atomic.
        if (await reclaimStaleLock(lockPath)) {
          continue;
        }
        throw new AppError("BROWSER_PROFILE_LOCK_FAILED", "The native browser profile has a stale lock that could not be reclaimed. Verify that no SmoothOperator process is using it, then remove the lock file and retry.", { retryable: true });
      }
    }
  }

  throw new AppError("BROWSER_PROFILE_IN_USE", "The native browser profile became busy while it was being acquired.", { retryable: true });
}

/** Atomically move a provably-dead owner's lock aside so acquisition can
 * retry. Re-validates liveness and identity immediately before the rename to
 * keep the steal window as small as the platform allows. */
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  try {
    const before = await lstat(lockPath);
    const raw = await readFile(lockPath, "utf8");
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (fileSystemErrorCode(error) !== "ESRCH") {
        return false;
      }
    }
    const after = await lstat(lockPath);
    if (after.ino !== before.ino || after.dev !== before.dev) {
      return false;
    }
    await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
    return true;
  } catch {
    return false;
  }
}

async function readProfileLock(lockPath: string): Promise<"active" | "stale" | "missing" | "unknown"> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    return fileSystemErrorCode(error) === "ENOENT" ? "missing" : "unknown";
  }
  try {
    const value = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
    if (!pid) {
      return "unknown";
    }
    try {
      process.kill(pid, 0);
      return "active";
    } catch (error) {
      return fileSystemErrorCode(error) === "ESRCH" ? "stale" : "active";
    }
  } catch {
    return "unknown";
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const target = resolve(path);
  if (dirname(target) === target) {
    throw new AppError("CONFIG_INSECURE", `The runtime path '${path}' must not be a filesystem root.`);
  }
  // Walk to nearest existing ancestor to avoid symlink-following mkdir.
  const missingSegments: string[] = [];
  let existingPath = target;
  while (true) {
    try {
      await lstat(existingPath);
      break;
    } catch (error) {
      if (fileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        throw new AppError("CONFIG_INSECURE", `The runtime path '${path}' could not be resolved safely.`);
      }
      missingSegments.push(basename(existingPath));
      existingPath = parent;
    }
  }

  let checkedPath = existingPath;
  while (true) {
    await assertPrivateDirectoryComponent(checkedPath, path);
    const parent = dirname(checkedPath);
    if (parent === checkedPath) {
      break;
    }
    checkedPath = parent;
  }
  let currentPath = existingPath;
  for (const segment of missingSegments.reverse()) {
    currentPath = join(currentPath, segment);
    try {
      await mkdir(currentPath, { mode: 0o700 });
    } catch (error) {
      if (fileSystemErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    await assertPrivateDirectoryComponent(currentPath, path);
  }

  let info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AppError("CONFIG_INSECURE", `The runtime path '${path}' must be a real directory, not a symbolic link or file.`);
  }
  let permissions = Number(info.mode) & 0o777;
  if ((permissions & 0o077) !== 0) {
    await chmod(target, 0o700);
    info = await lstat(target);
    await assertPrivateDirectoryComponent(target, path);
    permissions = Number(info.mode) & 0o777;
  }
  if ((permissions & 0o077) !== 0) {
    throw new AppError("CONFIG_INSECURE", `The runtime directory '${path}' must not be group/world-readable.`);
  }
}

async function assertPrivateDirectoryComponent(componentPath: string, originalPath: string): Promise<void> {
  const info = await lstat(componentPath);
  if (info.isSymbolicLink()) {
    if (await isAllowedMacSystemAlias(componentPath)) {
      return;
    }
    throw new AppError("CONFIG_INSECURE", `The runtime path '${originalPath}' must be a real directory without a symbolic link in any path component.`);
  }
  if (!info.isDirectory()) {
    throw new AppError("CONFIG_INSECURE", `The runtime path '${originalPath}' must be a real directory, not a symbolic link or file.`);
  }
}

async function isAllowedMacSystemAlias(componentPath: string): Promise<boolean> {
  // macOS exposes these stable aliases for system directories.  Preserve
  // them only when they resolve to the corresponding /private location; an
  // arbitrary user symlink is never accepted as a runtime ancestor.
  const alias = resolve(componentPath);
  if (alias !== "/var" && alias !== "/tmp" && alias !== "/etc") {
    return false;
  }
  const canonical = await realpath(componentPath).catch(() => undefined);
  return canonical === `/private${alias}`;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new AppError("CANCELLED", "The browser action was cancelled.");
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new AppError("CANCELLED", "The browser action was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
  });
}

async function runShutdownPhase(
  label: string,
  operation: () => Promise<unknown>,
  timeoutMs: number,
  logger: Logger,
): Promise<{ status: "complete" | "failed" | "timeout"; value?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ status: "complete" as const, value }),
      (error: unknown) => {
        logger.warn("MCP shutdown phase failed", { phase: label, ...safeErrorDiagnostic(error) });
        return { status: "failed" as const };
      },
    );
  const timeout = new Promise<{ status: "timeout" }>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise({ status: "timeout" }), timeoutMs);
  });
  const result = await Promise.race([task, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result.status === "timeout") {
    logger.warn("MCP shutdown phase timed out", { phase: label, timeoutMs });
  }
  return result;
}
