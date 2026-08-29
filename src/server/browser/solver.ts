/**
 * Pluggable CAPTCHA solver layer.
 *
 * This module produces HTTP-polling solver objects for external CAPTCHA
 * services. It is deliberately decoupled from the browser runtime: it only
 * uses the global `fetch` and Node built-ins, and returns tokens plus the
 * field they must be injected into. Wiring into the browser service is a
 * separate concern.
 *
 * The contract is opt-in and graceful: with no API key configured,
 * `buildSolver` returns `null` so the caller falls back to human-in-the-loop
 * rather than failing. Every provider response is bounded, wrapped as
 * untrusted text, and never logged with secrets.
 */

import type { ChallengeKind } from "./challenges";
import type { ServerConfig } from "../config";
import { AppError, SOLVER_REFUSED, SOLVER_TIMEOUT } from "../errors";
import { Logger, redactValue } from "../logger";
import { wrapUntrustedText } from "../security";

const DEFAULT_SOLVER_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REFUSED_REASON_MAX_CHARS = 500;
const MAX_TASK_ID_CHARS = 1_024;
const TOKEN_MAX_CHARS = 8_192;

const DEFAULT_BASE_URLS: Record<string, string> = {
  "2captcha": "https://2captcha.com",
  capsolver: "https://api.capsolver.com",
  anticaptcha: "https://api.anticaptcha.com",
};

/** Canonical response field name per challenge kind (the injection target). */
const FIELD_BY_KIND: Record<string, string> = {
  recaptcha: "gRecaptchaResponse",
  "recaptcha-enterprise": "gRecaptchaResponse",
  "cloudflare-turnstile": "cfTurnstileResponse",
  "openai-turnstile": "cfTurnstileResponse",
  hcaptcha: "hCaptchaResponse",
  "hcaptcha-enterprise": "hCaptchaResponse",
  arkose: "fc-token",
};

/** Kinds that carry a human-like score (reCAPTCHA v3, non-interactive Turnstile). */
const SCORE_CAPABLE_KINDS: ReadonlySet<ChallengeKind> = new Set<ChallengeKind>([
  "recaptcha",
  "recaptcha-enterprise",
  "cloudflare-turnstile",
  "openai-turnstile",
]);

export interface SolveRequest {
  sitekey?: string;
  pageurl: string;
  kind: ChallengeKind;
  scoreBased: boolean;
  proxyUrl?: string;
  action?: string;
  minScore?: number;
}

export interface SolveResult {
  token: string;
  fieldSelector: string;
  reFireEvent?: string;
}

export interface SolverProvider {
  readonly name: string;
  supports(kind: ChallengeKind, scoreBased: boolean): boolean;
  solve(req: SolveRequest, signal: AbortSignal): Promise<SolveResult>;
}

/**
 * Map a challenge kind to the canonical response field the service injects
 * into. Providers may override this with a provider-specific selector, but the
 * canonical name is the stable default the service resolves against the DOM.
 */
export function fieldSelectorForKind(kind: ChallengeKind): string {
  return FIELD_BY_KIND[kind] ?? "captcha-response";
}

function refused(reason: string): AppError {
  const bounded = reason.slice(0, REFUSED_REASON_MAX_CHARS);
  return new AppError(SOLVER_REFUSED, `The CAPTCHA solver refused the request (${bounded}).`, {
    details: { classification: "refused", reason: redactValue(bounded) as string },
  });
}

function timedOut(timeoutMs: number): AppError {
  return new AppError(SOLVER_TIMEOUT, `The CAPTCHA solver exceeded its ${timeoutMs}ms deadline.`, {
    retryable: true,
    details: { classification: "timeout", timeoutMs },
  });
}

function abortedError(): AppError {
  return new AppError("CANCELLED", "The CAPTCHA solver request was aborted.", {
    details: { classification: "aborted" },
  });
}

function validateRequest(req: SolveRequest): void {
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    throw new AppError("SOLVER_INVALID", "The solve request must be an object.");
  }
  if (typeof req.pageurl !== "string" || req.pageurl.length === 0) {
    throw new AppError("SOLVER_INVALID", "A non-empty 'pageurl' is required.");
  }
  if (typeof req.kind !== "string" || req.kind.length === 0) {
    throw new AppError("SOLVER_INVALID", "A challenge 'kind' is required.");
  }
}

/** A bounded wall-clock deadline that also follows an external abort signal. */
interface Deadline {
  readonly signal: AbortSignal;
  readonly deadline: number;
  timedOut(): boolean;
  clear(): void;
}

function createDeadline(timeoutMs: number, signal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = (): void => {
    if (!timedOut) {
      controller.abort();
    }
  };
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeoutMsTrunc = Math.max(0, Math.trunc(timeoutMs));
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMsTrunc);
  return {
    signal: controller.signal,
    deadline: Date.now() + timeoutMsTrunc,
    timedOut: () => timedOut,
    clear(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

type PollOutcome =
  | { type: "ready"; token: string }
  | { type: "not-ready" }
  | { type: "refused"; reason: string };

/**
 * Poll a provider until the token is ready, the provider refuses, or the
 * deadline elapses. Every iteration is bounded by the deadline and the shared
 * abort signal, so an uncooperative provider can never loop forever.
 */
async function pollForToken(
  doPoll: (signal: AbortSignal) => Promise<PollOutcome>,
  timeoutMs: number,
  pollIntervalMs: number,
  deadline: Deadline,
): Promise<string> {
  for (;;) {
    if (deadline.timedOut()) {
      throw timedOut(timeoutMs);
    }
    let outcome: PollOutcome;
    try {
      outcome = await doPoll(deadline.signal);
    } catch (error) {
      if (deadline.timedOut()) {
        throw timedOut(timeoutMs);
      }
      if (deadline.signal.aborted) {
        throw abortedError();
      }
      throw error;
    }
    if (outcome.type === "ready") {
      return outcome.token;
    }
    if (outcome.type === "refused") {
      throw refused(outcome.reason);
    }
    if (deadline.timedOut() || Date.now() >= deadline.deadline) {
      throw timedOut(timeoutMs);
    }
    const remaining = Math.max(0, deadline.deadline - Date.now());
    await sleepUntil(deadline.signal, Math.min(pollIntervalMs, remaining));
  }
}

function sleepUntil(signal: AbortSignal, waitMs: number): Promise<void> {
  if (waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read a response body as bytes and cap it at `maxBytes`. The stream is
 * stopped as soon as the budget is reached so an oversized body can never be
 * fully allocated; the decoded text is then trimmed to the same budget.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) {
        throw new AppError(SOLVER_REFUSED, "The solver response body was not a valid byte stream.", {
          details: { classification: "invalid_response" },
        });
      }
      if (total + value.byteLength > maxBytes) {
        const room = maxBytes - total;
        if (room > 0) {
          chunks.push(value.subarray(0, room));
        }
        total = maxBytes;
        capped = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A test double or non-cooperative body may already release the lock.
    }
  }
  const bytes = concat(chunks);
  const text = new TextDecoder().decode(bytes);
  return capped && text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Shared HTTP helper: one request with a bounded body that decodes JSON and
 * throws `SOLVER_REFUSED` on HTTP errors. The response is capped at `maxBytes`
 * so a hostile provider cannot exhaust memory.
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  // Prefer a signal already attached to `init` (providers pass their own),
  // falling back to the deadline signal so a request is always cancellable.
  const response = await fetch(url, { ...init, signal: init?.signal ?? signal });
  if (!response.ok) {
    discardBody(response);
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : 0;
    throw new AppError(SOLVER_REFUSED, `The CAPTCHA solver returned HTTP ${response.status}.`, {
      retryable: status >= 500,
      details: { classification: "http_error", status },
    });
  }
  const text = await readBoundedResponseText(response, maxBytes);
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError(SOLVER_REFUSED, "The CAPTCHA solver returned an invalid JSON response.", {
      details: { classification: "invalid_json" },
      cause: error,
    });
  }
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A test double may not expose a cancellable body.
  }
}

function extractString(data: unknown, field: string): string | undefined {
  const value = (data as Record<string, unknown>)?.[field];
  return typeof value === "string" ? value : undefined;
}

function extractNumber(data: unknown, field: string): number | undefined {
  const value = (data as Record<string, unknown>)?.[field];
  return typeof value === "number" ? value : undefined;
}

/** Parse a proxy URL into `host:port`, tolerating userinfo and schemes. */
function proxyEndpoint(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    const host = parsed.hostname;
    const port = parsed.port;
    return port ? `${host}:${port}` : host;
  } catch {
    return proxyUrl.trim();
  }
}

function boundToken(token: string): string {
  return token.slice(0, TOKEN_MAX_CHARS);
}

/**
 * Base class for HTTP-polling solver providers. Owns the shared request,
 * bounded-read, poll-loop, and result-wrapping logic; subclasses supply the
 * provider-specific task submission, polling, and kind coverage.
 */
abstract class HttpPollingProvider implements SolverProvider {
  abstract readonly name: string;

  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly proxyUrl?: string;
  protected readonly timeoutMs: number;
  protected readonly maxBytes: number;
  protected readonly pollIntervalMs: number;
  protected readonly callbackUrl?: string;
  protected readonly logger: Logger;

  protected abstract readonly kinds: ReadonlySet<ChallengeKind>;

  constructor(
    kind: string,
    apiKey: string,
    config: NonNullable<ServerConfig["captchaSolver"]>,
    logger: Logger,
    callbackUrl?: string,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = (config.url && config.url.length > 0 ? config.url : DEFAULT_BASE_URLS[kind]) ?? DEFAULT_BASE_URLS[kind];
    this.proxyUrl = config.proxyUrl && config.proxyUrl.length > 0 ? config.proxyUrl : undefined;
    this.timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_SOLVER_TIMEOUT_MS;
    this.maxBytes = config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES;
    this.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    this.callbackUrl = callbackUrl;
    this.logger = logger;
  }

  supports(kind: ChallengeKind, scoreBased: boolean): boolean {
    if (!this.kinds.has(kind)) {
      return false;
    }
    // A score-based request targets a kind that actually scores; a scoreless
    // kind with scoreBased=true is a mismatch.
    if (scoreBased && !SCORE_CAPABLE_KINDS.has(kind)) {
      return false;
    }
    return true;
  }

  async solve(req: SolveRequest, signal: AbortSignal): Promise<SolveResult> {
    validateRequest(req);
    if (signal?.aborted) {
      throw abortedError();
    }
    const deadline = createDeadline(this.timeoutMs, signal);
    try {
      const taskId = await this.submitTask(req, deadline.signal);
      const token = await pollForToken(
        (sig) => this.poll(taskId, sig),
        this.timeoutMs,
        this.pollIntervalMs,
        deadline,
      );
      const fieldSelector = this.fieldSelector(req.kind);
      const result: SolveResult = { token: boundToken(token), fieldSelector };
      if (fieldSelector) {
        result.reFireEvent = fieldSelector;
      }
      this.logger.info("Captcha solver solved", {
        provider: this.name,
        kind: req.kind,
        outcome: "solved",
        scoreBased: req.scoreBased,
      });
      return {
        token: wrapUntrustedText("solver_token", result.token),
        fieldSelector: result.fieldSelector,
        ...(result.reFireEvent ? { reFireEvent: result.reFireEvent } : {}),
      };
    } catch (error) {
      // A deadline that fires while a submission request is in flight aborts
      // the shared signal; surface it as a timeout rather than a raw abort.
      if (deadline.timedOut()) {
        throw timedOut(this.timeoutMs);
      }
      if (signal?.aborted) {
        throw abortedError();
      }
      throw error;
    } finally {
      deadline.clear();
    }
  }

  protected abstract fieldSelector(kind: ChallengeKind): string;

  protected abstract submitTask(req: SolveRequest, signal: AbortSignal): Promise<string>;

  protected abstract poll(taskId: string, signal: AbortSignal): Promise<PollOutcome>;

  protected jsonBody(body: unknown, signal: AbortSignal): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify(body),
      signal,
    };
  }
}

/** 2Captcha: `in.php` submit + `res.php` GET polling. */
class TwoCaptchaProvider extends HttpPollingProvider {
  readonly name = "2captcha";
  protected readonly kinds = new Set<ChallengeKind>([
    "recaptcha",
    "recaptcha-enterprise",
    "hcaptcha",
    "hcaptcha-enterprise",
    "cloudflare-turnstile",
    "openai-turnstile",
    "arkose",
    "geetest",
    "geetest-v4",
    "friendlycaptcha",
    "kaptcha",
    "altcha",
    "aws-waf",
    "datadome",
  ]);

  protected async submitTask(req: SolveRequest, signal: AbortSignal): Promise<string> {
    const params = new URLSearchParams();
    params.set("method", "userrecaptcha");
    params.set("googlekey", req.sitekey ?? "");
    params.set("pageurl", req.pageurl);
    params.set("json", "1");
    if (this.proxyUrl) {
      params.set("proxy", "1");
      params.set("proxyAddress", proxyEndpoint(this.proxyUrl));
    }
    if (this.callbackUrl) {
      params.set("callback", this.callbackUrl);
    }
    if (req.scoreBased) {
      params.set("recaptcha_action", req.action ?? "");
      if (typeof req.minScore === "number") {
        params.set("recaptcha_min_score", String(req.minScore));
      }
    }
    const url = `${this.baseUrl}/in.php?${params.toString()}`;
    const data = (await fetchJson(url, { method: "POST", signal }, this.maxBytes)) as Record<string, unknown>;
    const status = extractNumber(data, "status");
    const request = extractString(data, "request");
    if (status === 1 && request) {
      return request.slice(0, MAX_TASK_ID_CHARS);
    }
    if (status === 0 && request) {
      throw refused(request);
    }
    throw refused("2Captcha did not return a task id");
  }

  protected async poll(taskId: string, signal: AbortSignal): Promise<PollOutcome> {
    const params = new URLSearchParams({ action: "get", id: taskId, json: "1" });
    const url = `${this.baseUrl}/res.php?${params.toString()}`;
    const data = (await fetchJson(url, { method: "GET", signal }, this.maxBytes)) as Record<string, unknown>;
    const status = extractNumber(data, "status");
    const request = extractString(data, "request");
    if (status === 1 && request && request !== "CAPCHA_NOT_READY") {
      return { type: "ready", token: request };
    }
    // `CAPCHA_NOT_READY` with status 0 means "keep polling", not a refusal.
    if (status === 0 && request === "CAPCHA_NOT_READY") {
      return { type: "not-ready" };
    }
    if (status === 0 && request) {
      return { type: "refused", reason: request };
    }
    return { type: "not-ready" };
  }

  protected fieldSelector(kind: ChallengeKind): string {
    return fieldSelectorForKind(kind);
  }
}

/** CapSolver: `createTask` / `getTaskResult` JSON polling. */
class CapSolverProvider extends HttpPollingProvider {
  readonly name = "capsolver";
  protected readonly kinds = new Set<ChallengeKind>([
    "recaptcha",
    "recaptcha-enterprise",
    "hcaptcha",
    "hcaptcha-enterprise",
    "cloudflare-turnstile",
    "openai-turnstile",
    "arkose",
    "geetest-v4",
    "datadome",
    "aws-waf",
  ]);

  protected taskType(req: SolveRequest): string {
    const score = req.scoreBased;
    switch (req.kind) {
      case "recaptcha":
        return score ? "ReCaptchaV3TaskProxyLess" : "ReCaptchaV2TaskProxyLess";
      case "recaptcha-enterprise":
        return score ? "ReCaptchaV3TaskProxyLess" : "ReCaptchaV2TaskProxyLess";
      case "hcaptcha":
      case "hcaptcha-enterprise":
        return "HCaptchaTaskProxyLess";
      case "cloudflare-turnstile":
      case "openai-turnstile":
        return "CloudflareTurnstileTaskGeneral";
      case "arkose":
        return "FunCaptchaTaskProxyLess";
      case "geetest-v4":
        return "GeeTestTaskProxyLess";
      case "datadome":
        return "DataDomeTaskProxyLess";
      case "aws-waf":
        return "AwsWafTaskProxyLess";
      default:
        return "ReCaptchaV2TaskProxyLess";
    }
  }

  protected solutionToken(solution: Record<string, unknown>): string | undefined {
    return extractString(solution, "RecaptchaResponse")
      ?? extractString(solution, "HCaptchaResponse")
      ?? extractString(solution, "TurnstileResponse")
      ?? extractString(solution, "FunCaptchaToken");
  }

  protected async submitTask(req: SolveRequest, signal: AbortSignal): Promise<string> {
    const task: Record<string, unknown> = {
      type: this.taskType(req),
      websiteKey: req.sitekey ?? "",
      websiteURL: req.pageurl,
    };
    if (req.scoreBased && req.action) {
      task.action = req.action;
    }
    if (this.proxyUrl) {
      task.proxyUrl = this.proxyUrl;
    }
    const body = await fetchJson(
      `${this.baseUrl}/createTask`,
      this.jsonBody({ clientKey: this.apiKey, task }, signal),
      this.maxBytes,
      signal,
    ) as Record<string, unknown>;
    const errorId = extractNumber(body, "errorId");
    if (errorId && errorId !== 0) {
      throw refused(extractString(body, "errorDescription") ?? "CapSolver task error");
    }
    const taskId = extractString(body, "taskId");
    if (!taskId) {
      throw refused("CapSolver did not return a task id");
    }
    return taskId.slice(0, MAX_TASK_ID_CHARS);
  }

  protected async poll(taskId: string, signal: AbortSignal): Promise<PollOutcome> {
    const body = await fetchJson(
      `${this.baseUrl}/getTaskResult`,
      this.jsonBody({ clientKey: this.apiKey, taskId }, signal),
      this.maxBytes,
      signal,
    ) as Record<string, unknown>;
    const errorId = extractNumber(body, "errorId");
    if (errorId && errorId !== 0) {
      return { type: "refused", reason: extractString(body, "errorDescription") ?? "CapSolver task error" };
    }
    const status = extractString(body, "status");
    if (status === "ready") {
      const solution = body["solution"] as Record<string, unknown> | undefined;
      const token = solution ? this.solutionToken(solution) : undefined;
      if (token) {
        return { type: "ready", token };
      }
      return { type: "refused", reason: "CapSolver returned no solution" };
    }
    return { type: "not-ready" };
  }

  protected fieldSelector(kind: ChallengeKind): string {
    return fieldSelectorForKind(kind);
  }
}

/** Anti-Captcha: `createTask` / `getTaskResult` JSON polling. */
class AntiCaptchaProvider extends HttpPollingProvider {
  readonly name = "anticaptcha";
  protected readonly kinds = new Set<ChallengeKind>([
    "recaptcha",
    "recaptcha-enterprise",
    "hcaptcha",
    "hcaptcha-enterprise",
    "friendlycaptcha",
    "aws-waf",
    "altcha",
  ]);

  protected taskType(req: SolveRequest): string {
    const score = req.scoreBased;
    switch (req.kind) {
      case "recaptcha":
        return score ? "RecaptchaV3TaskProxyless" : "RecaptchaV2TaskProxyless";
      case "recaptcha-enterprise":
        return score ? "RecaptchaV3EnterpriseTaskProxyless" : "RecaptchaV2EnterpriseTaskProxyless";
      case "hcaptcha":
      case "hcaptcha-enterprise":
        return "HCaptchaTaskProxyless";
      case "friendlycaptcha":
        return "FriendlyCaptchaTaskProxyless";
      case "aws-waf":
        return "AwsWafTaskProxyless";
      case "altcha":
        return "AltchaTaskProxyless";
      default:
        return "RecaptchaV2TaskProxyless";
    }
  }

  protected solutionToken(solution: Record<string, unknown>): string | undefined {
    return extractString(solution, "gRecaptchaResponse")
      ?? extractString(solution, "gRecaptchaV3Token")
      ?? extractString(solution, "hCaptchaResponse");
  }

  protected async submitTask(req: SolveRequest, signal: AbortSignal): Promise<string> {
    const task: Record<string, unknown> = {
      type: this.taskType(req),
      websiteKey: req.sitekey ?? "",
      websiteUrl: req.pageurl,
    };
    if (this.proxyUrl) {
      task.proxy = { type: "HTTP", address: proxyEndpoint(this.proxyUrl) };
    }
    const body = await fetchJson(
      `${this.baseUrl}/createTask`,
      this.jsonBody({ clientKey: this.apiKey, task }, signal),
      this.maxBytes,
      signal,
    ) as Record<string, unknown>;
    const errorId = extractNumber(body, "errorId");
    if (errorId && errorId !== 0) {
      throw refused(extractString(body, "errorText") ?? "Anti-Captcha task error");
    }
    const taskId = extractString(body, "taskId");
    if (!taskId) {
      throw refused("Anti-Captcha did not return a task id");
    }
    return taskId.slice(0, MAX_TASK_ID_CHARS);
  }

  protected async poll(taskId: string, signal: AbortSignal): Promise<PollOutcome> {
    const body = await fetchJson(
      `${this.baseUrl}/getTaskResult`,
      this.jsonBody({ clientKey: this.apiKey, taskId }, signal),
      this.maxBytes,
      signal,
    ) as Record<string, unknown>;
    const errorId = extractNumber(body, "errorId");
    if (errorId && errorId !== 0) {
      return { type: "refused", reason: extractString(body, "errorText") ?? "Anti-Captcha task error" };
    }
    const status = extractString(body, "status");
    if (status === "ready") {
      const solution = body["solution"] as Record<string, unknown> | undefined;
      const token = solution ? this.solutionToken(solution) : undefined;
      if (token) {
        return { type: "ready", token };
      }
      return { type: "refused", reason: "Anti-Captcha returned no solution" };
    }
    return { type: "not-ready" };
  }

  protected fieldSelector(kind: ChallengeKind): string {
    return fieldSelectorForKind(kind);
  }
}

/**
 * Build a solver for the configured provider. Returns `null` when no provider
 * is configured or no API key is set, so the caller can fall back to
 * human-in-the-loop without a hard failure.
 */
export function buildSolver(
  config: Pick<ServerConfig, "captchaSolver">,
  logger: Logger = new Logger("info"),
): SolverProvider | null {
  const captcha = config.captchaSolver;
  if (!captcha || captcha.provider === "none" || !captcha.apiKey) {
    return null;
  }
  const { provider, apiKey } = captcha;
  switch (provider) {
    case "2captcha":
      return make2Captcha(apiKey, captcha, logger);
    case "capsolver":
      return makeCapSolver(apiKey, captcha, logger);
    case "anticaptcha":
      return makeAntiCaptcha(apiKey, captcha, logger);
    default:
      // Unknown provider falls back gracefully to human-in-the-loop.
      return null;
  }
}

export function make2Captcha(
  apiKey: string,
  config: NonNullable<ServerConfig["captchaSolver"]>,
  logger: Logger,
  callbackUrl?: string,
): SolverProvider {
  return new TwoCaptchaProvider("2captcha", apiKey, config, logger, callbackUrl);
}

export function makeCapSolver(
  apiKey: string,
  config: NonNullable<ServerConfig["captchaSolver"]>,
  logger: Logger,
): SolverProvider {
  return new CapSolverProvider("capsolver", apiKey, config, logger);
}

export function makeAntiCaptcha(
  apiKey: string,
  config: NonNullable<ServerConfig["captchaSolver"]>,
  logger: Logger,
): SolverProvider {
  return new AntiCaptchaProvider("anticaptcha", apiKey, config, logger);
}
