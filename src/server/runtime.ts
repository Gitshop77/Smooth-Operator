import { chmod, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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
  private profileLeasePromise?: Promise<void>;
  private closing = false;

  private constructor(readonly config: ServerConfig, private browserProfileLease?: BrowserProfileLease) {
    this.logger = new Logger(config.logLevel, { component: "smooth-operator" });
    this.policy = new SecurityPolicy(config);
    this.browser = new BrowserService(config, this.policy, this.logger.child({ component: "browser" }));
    this.research = new ResearchService(this.policy, this.logger.child({ component: "research" }));
  }

  /** True when this session's config implies ownership of the shared managed
   * browser profile (and therefore of its lease). */
  private get profileLeaseRequired(): boolean {
    const ownsBrowserProcess = this.config.browser.mode !== "disabled" && (this.config.browser.mode === "managed" || this.config.browser.mode === "launch"
      || (this.config.browser.autoLaunch && Boolean(this.config.browser.executablePath)));
    return Boolean(ownsBrowserProcess && this.config.browser.userDataDir);
  }

  /** Browser operations must hold the profile lease before touching the
   * managed browser. Acquisition is lazy so concurrent harness sessions stay
   * connected while idle; only genuinely simultaneous browsing conflicts,
   * and that surfaces as a retryable tool error instead of a dead server. */
  private async ensureBrowserProfileLease(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    if (signal?.aborted) {
      throw new AppError("CANCELLED", "The browser action was cancelled.");
    }
    if (!this.profileLeaseRequired || this.browserProfileLease || !this.config.browser.userDataDir) {
      return;
    }
    if (!this.profileLeasePromise) {
      const acquisition = (async () => {
        try {
          await ensurePrivateDirectory(this.config.browser.userDataDir!);
          const lease = await acquireBrowserProfileLease(this.config.browser.userDataDir!);
          if (this.closing) {
            await lease.release();
            throw new AppError("SERVER_CLOSING", "The browser runtime is shutting down.", { retryable: true });
          }
          this.browserProfileLease = lease;
          this.logger.info("Acquired browser profile lease on demand");
        } catch (error) {
          if (error instanceof AppError && (error.code === "BROWSER_PROFILE_IN_USE" || error.code === "BROWSER_PROFILE_LOCK_FAILED")) {
            throw new AppError("BROWSER_PROFILE_IN_USE", "Another SmoothOperator session currently owns the managed browser profile. Retry when that session closes, or switch one of them to connect mode.", { retryable: true });
          }
          throw error;
        }
      })();
      this.profileLeasePromise = acquisition;
      // A caller may stop waiting without cancelling the filesystem work.
      // Keep the shared promise installed until that work settles so a second
      // request cannot start a concurrent profile-lock acquisition.
      void acquisition.then(
        () => {
          if (this.profileLeasePromise === acquisition) {
            this.profileLeasePromise = undefined;
          }
        },
        () => {
          if (this.profileLeasePromise === acquisition) {
            this.profileLeasePromise = undefined;
          }
        },
      );
    }
    const pending = this.profileLeasePromise;
    await awaitWithAbort(pending, signal);
    this.assertOpen();
  }

  static async create(config: ServerConfig): Promise<ServerRuntime> {
    let browserProfileLease: BrowserProfileLease | undefined;
    try {
      await ensurePrivateDirectory(config.dataDir);
      // These sibling roots have no ordering dependency once the private
      // data directory exists. Initialize them concurrently to shorten cold
      // startup while retaining each root's independent symlink/permission
      // checks.
      await Promise.all([
        ensurePrivateDirectory(join(config.dataDir, "downloads")),
        ensurePrivateDirectory(join(config.dataDir, "files")),
      ]);
      const ownsBrowserProcess = config.browser.mode !== "disabled" && (config.browser.mode === "managed" || config.browser.mode === "launch"
        || (config.browser.autoLaunch && Boolean(config.browser.executablePath)));
      const needsProfileLease = Boolean(ownsBrowserProcess && config.browser.userDataDir);
      if (needsProfileLease && config.browser.userDataDir) {
        await ensurePrivateDirectory(config.browser.userDataDir);
        // The lease is optional at startup: a concurrent SmoothOperator
        // session may own it right now. Killing this MCP connection would
        // break every tool, so start degraded and let each browser
        // operation retry the lease lazily (see ensureBrowserProfileLease).
        browserProfileLease = await acquireBrowserProfileLease(config.browser.userDataDir).catch((error: unknown) => {
          if (error instanceof AppError && (error.code === "BROWSER_PROFILE_IN_USE" || error.code === "BROWSER_PROFILE_LOCK_FAILED")) {
            return undefined;
          }
          throw error;
        });
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
      this.closing = true;
      const pendingProfileAcquisition = this.profileLeasePromise;
      this.closePromise = (async () => {
        if (pendingProfileAcquisition) {
          await runShutdownPhase("browser profile lease acquisition", () => pendingProfileAcquisition, PROFILE_ACQUISITION_SETTLE_TIMEOUT_MS, this.logger);
        }
        const [browserClose] = await Promise.all([
          runShutdownPhase("browser close", () => this.browser.shutdownOutcome(), RUNTIME_SHUTDOWN_TIMEOUT_MS, this.logger),
          runShutdownPhase("research close", () => this.research.close(), PROFILE_ACQUISITION_SETTLE_TIMEOUT_MS, this.logger),
        ]);
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
    await this.ensureBrowserProfileLease(signal);
    this.assertOpen();
    return this.browser.execute(action, signal);
  }

  async runBatch(actions: BrowserAction[], options: { confirmDestructive?: boolean; includeSnapshot?: boolean } = {}, signal?: AbortSignal): Promise<unknown> {
    await this.ensureBrowserProfileLease(signal);
    this.assertOpen();
    return this.browser.executeBatch(actions, options, signal);
  }

  async snapshot(options: NonNullable<Parameters<BrowserService["snapshot"]>[0]>, signal?: AbortSignal): Promise<PageSnapshot> {
    await this.ensureBrowserProfileLease(signal);
    this.assertOpen();
    return this.browser.snapshot({ ...options, signal });
  }

  async listTabs(signal?: AbortSignal): Promise<unknown> {
    await this.ensureBrowserProfileLease(signal);
    this.assertOpen();
    return this.browser.listTabs(signal);
  }

  listSessions(): unknown {
    this.assertOpen();
    return [this.browser.sessionSummary()];
  }

  async browserDoctor(): Promise<Record<string, unknown>> {
    this.assertOpen();
    return this.browser.doctor();
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new AppError("CANCELLED", "The browser action was cancelled.");
    }
    await this.ensureBrowserProfileLease(signal);
    this.assertOpen();
    return awaitWithAbort(this.browser.closeSession(sessionId), signal);
  }

  async webSearch(query: string, options: Omit<ResearchRequest, "query">, signal?: AbortSignal): Promise<unknown> {
    this.assertOpen();
    return this.research.research(query, options, signal);
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AppError("SERVER_CLOSING", "The MCP runtime is shutting down.", { retryable: true });
    }
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
      defaults: {
        browserMode: "managed",
        headedBrowser: true,
        pageEvaluation: true,
        stealth: true,
        behavioralTiming: false,
      },
      features: {
        localBrowserTools: "available",
        pageEvaluation: this.config.security.allowEval,
        stealth: this.config.stealth.enabled,
        behavioralTiming: this.config.stealth.behaviorEnabled,
      },
      browser: {
        mode: this.config.browser.mode,
        configured: managedBrowser || (!browserDisabled
          && (usesExecutable ? Boolean(this.config.browser.executablePath) : Boolean(this.config.browser.wsEndpoint || this.config.browser.url))),
        connection: browserDisabled ? "disabled" : managedBrowser ? "managed" : usesExecutable ? "executable" : this.config.browser.wsEndpoint ? "websocket" : "devtools-http",
        runtime: browserDisabled ? { connected: false, owned: false, trackedPages: 0, queuedOperations: 0, currentPageId: null, recoveryRequired: false, idleTimeoutMs: this.config.browser.idleTimeoutMs } : this.browser.connectionStatus(),
        actionTimeoutMs: this.config.browser.actionTimeoutMs,
        connectTimeoutMs: this.config.browser.connectTimeoutMs,
        cdpTimeoutMs: this.config.browser.cdpTimeoutMs,
        idleTimeoutMs: this.config.browser.idleTimeoutMs,
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
      challenges: {
        classification: "bounded-evidence",
        connectedAiLoop: true,
        humanHandoff: true,
        successRequiresAbsentClassification: true,
        defaultMaxAttempts: 32,
        maxAttempts: 100,
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
const MAX_PROFILE_LOCK_BYTES = 4_096;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000;
const PROFILE_ACQUISITION_SETTLE_TIMEOUT_MS = 1_000;
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
      let lockIdentity: Awaited<ReturnType<typeof handle.stat>>;
      try {
        lockIdentity = await handle.stat();
      } catch (error) {
        await handle.close().catch(() => undefined);
        // Leave the lock for explicit operator recovery if its identity could
        // not be established safely.
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
          const currentIdentity = await lstat(lockPath).catch(() => undefined);
          if (!currentIdentity || !sameFileIdentity(lockIdentity, currentIdentity)) {
            return;
          }
          const current = await readBoundedProfileLock(lockPath);
          let ownsCurrentLock = false;
          if (current) {
            try {
              ownsCurrentLock = (JSON.parse(current) as { token?: unknown }).token === token;
            } catch {
              ownsCurrentLock = false;
            }
          }
          const verifiedIdentity = ownsCurrentLock
            ? await lstat(lockPath).catch(() => undefined)
            : undefined;
          if (ownsCurrentLock && verifiedIdentity && sameFileIdentity(lockIdentity, verifiedIdentity)) {
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
    if (before.isSymbolicLink() || !before.isFile()) {
      return false;
    }
    const raw = await readBoundedProfileLock(lockPath);
    if (raw === undefined) {
      return false;
    }
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
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, stalePath);
    // The rename is the atomic ownership handoff. Once the old entry has a
    // private, unique name no contender can acquire it, so remove the
    // tombstone instead of accumulating one file per stale recovery. A
    // cleanup failure is harmless and remains recoverable by an operator.
    await unlink(stalePath).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function readProfileLock(lockPath: string): Promise<"active" | "stale" | "missing" | "unknown"> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    return fileSystemErrorCode(error) === "ENOENT" ? "missing" : "unknown";
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return "unknown";
  }
  const raw = await readBoundedProfileLock(lockPath);
  if (raw === undefined) {
    return "unknown";
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

/** Read only the small JSON envelope used for profile ownership. */
async function readBoundedProfileLock(lockPath: string): Promise<string | undefined> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | noFollow);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PROFILE_LOCK_BYTES) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(MAX_PROFILE_LOCK_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return offset > MAX_PROFILE_LOCK_BYTES ? undefined : buffer.subarray(0, offset).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
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

  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AppError("CONFIG_INSECURE", `The runtime path '${path}' must be a real directory, not a symbolic link or file.`);
  }
  // Node exposes POSIX mode bits on Windows, but they are not the directory's
  // effective ACL and commonly look world-readable for every normal folder.
  // Keep the symlink/type checks on all platforms and enforce owner-only mode
  // bits where the platform actually exposes them.
  if (process.platform !== "win32") {
    let permissions = Number(info.mode) & 0o777;
    if ((permissions & 0o077) !== 0) {
      await chmod(target, 0o700);
      const tightened = await lstat(target);
      await assertPrivateDirectoryComponent(target, path);
      permissions = Number(tightened.mode) & 0o777;
    }
    if ((permissions & 0o077) !== 0) {
      throw new AppError("CONFIG_INSECURE", `The runtime directory '${path}' must not be group/world-readable.`);
    }
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

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
    if (signal.aborted) {
      onAbort();
      return;
    }
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
