/**
 * background/webhook-delivery.ts — bounded, SSRF-guarded webhook delivery.
 *
 * The webhook is a user-configured notification endpoint; a hostile or
 * mistyped value must never exfiltrate task data, hit a private/metadata
 * address, or stall the service worker. Delivery therefore:
 * - validates the URL through the DNS-resolving SSRF guard,
 * - redacts the task text and bounds the payload before POSTing,
 * - times out, never redirects, and never throws (failures are reported as
 *   result codes so callers can log a MASKED URL, never the raw endpoint),
 * - retries only transient outcomes (429/5xx and network/timeout errors) with
 *   bounded full-jitter backoff honoring `Retry-After`, carrying an
 *   `Idempotency-Key` so redeliveries dedupe at the receiver — a single
 *   bounded POST would treat every outcome as final and drop a delivery on
 *   one transient 503. 4xx (other than 429) is never retried.
 */

import { resolveAndValidateWebhookUrl } from "@/lib/agent/llm/route/ssrf";
import { redactSecrets } from "@/lib/agent/secrets";
import { redactKeyShapes } from "@/lib/agent/key-shape-redact";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_TASK_CHARS = 2_000;
export const WEBHOOK_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Bounded retry count (initial attempt + 2 retries). */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** Backoff base/cap for the full-jitter schedule (ms). */
export const WEBHOOK_BACKOFF_BASE_MS = 500;
export const WEBHOOK_BACKOFF_CAP_MS = 4_000;
/** Upper bound on a `Retry-After` honor (ms) so a hostile header cannot stall the SW. */
export const WEBHOOK_RETRY_AFTER_CAP_MS = 10_000;

export type WebhookDeliveryResult =
  | { ok: true; code: "sent"; status: number }
  | { ok: false; code: "ssrf_blocked" | "invalid_url" | "network_error" | "timeout" | "oversized" };

export interface WebhookPayload {
  task: string;
  success: boolean;
  text: string;
  timestamp: number;
  /** Optional caller-supplied idempotency key; derived from the payload when absent. */
  idempotencyKey?: string;
}

/** True when the HTTP status is a transient failure worth a retry. */
export function isTransientWebhookStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Full-jitter backoff delay for a retry: `random() * min(cap, base * 2**attempt)`.
 * Bounded so synchronized clients spread instead of re-saturating the overload.
 */
export function computeWebhookBackoffMs(attempt: number, random: () => number = Math.random): number {
  const bounded = Math.min(WEBHOOK_BACKOFF_CAP_MS, WEBHOOK_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * bounded);
}

/** Parse a `Retry-After` header (seconds or HTTP-date); `null` when unparseable. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

/** Deterministic idempotency key derived from the payload (stable across retries). */
export function deriveWebhookIdempotencyKey(payload: WebhookPayload): string {
  return `${payload.timestamp}:${payload.task.length}:${payload.text.length}`;
}

/**
 * Mask a webhook URL for logs/diagnostics: scheme + host only, with any
 * userinfo credentials replaced by `[REDACTED]` and any path collapsed to
 * `…`. Never leaks credentials, query tokens, or path structure.
 */
export function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hasUserinfo = parsed.username !== "" || parsed.password !== "";
    const userinfo = hasUserinfo ? "[REDACTED]@" : "";
    const path = parsed.pathname && parsed.pathname !== "/" ? "/…" : "";
    return `${parsed.protocol}//${userinfo}${parsed.host}${path}`;
  } catch {
    return "(invalid webhook URL)";
  }
}

/** One bounded POST attempt. Resolves with the Response, or a transport tag. */
async function attemptWebhookPost(
  safeUrl: string,
  body: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch,
): Promise<Response | "timeout" | "network_error"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    return await fetchImpl(safeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (e) {
    return e instanceof DOMException && e.name === "AbortError" ? "timeout" : "network_error";
  } finally {
    clearTimeout(timer);
  }
}

interface WebhookDeliveryOptions {
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Deliver one bounded webhook POST with transient retries. Never throws;
 * returns a result code. `fetchImpl` is injectable for tests.
 */
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
  options: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    const check = await resolveAndValidateWebhookUrl(url, "user-configured");
    if (!check.ok) return { ok: false, code: "ssrf_blocked" };
    let safeUrl: string;
    try {
      safeUrl = new URL(url).toString();
    } catch {
      return { ok: false, code: "invalid_url" };
    }
    const redactedTask = redactKeyShapes(await redactSecrets(payload.task));
    const task =
      redactedTask.length > WEBHOOK_MAX_TASK_CHARS
        ? redactedTask.slice(0, WEBHOOK_MAX_TASK_CHARS) + "…"
        : redactedTask;
    const idempotencyKey = payload.idempotencyKey ?? deriveWebhookIdempotencyKey(payload);
    const body = JSON.stringify({
      success: payload.success,
      text: payload.text,
      task,
      timestamp: payload.timestamp,
      idempotencyKey,
    });
    if (body.length > WEBHOOK_MAX_PAYLOAD_BYTES) return { ok: false, code: "oversized" };

    for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const response = await attemptWebhookPost(safeUrl, body, idempotencyKey, fetchImpl);
      if (typeof response === "string") {
        // Transport failure — timeouts and network errors are both transient
        // and retried; the final attempt reports the honest code.
        if (attempt === WEBHOOK_MAX_ATTEMPTS - 1) return { ok: false, code: response };
        await sleep(Math.min(WEBHOOK_RETRY_AFTER_CAP_MS, computeWebhookBackoffMs(attempt)));
        continue;
      }
      const status = response.status;
      if (status >= 200 && status < 300) return { ok: true, code: "sent", status };
      if (!isTransientWebhookStatus(status) || attempt === WEBHOOK_MAX_ATTEMPTS - 1) {
        // Never retry 4xx (other than 429); a final transient failure is
        // reported as network_error (the raw body is never surfaced).
        return { ok: false, code: "network_error" };
      }
      // Honor Retry-After (cap-bounded) when present; else full-jitter backoff.
      let retryAfter: number | null = null;
      try {
        retryAfter = parseRetryAfterMs(response.headers?.get?.("Retry-After") ?? null);
      } catch {
        retryAfter = null;
      }
      await sleep(Math.min(WEBHOOK_RETRY_AFTER_CAP_MS, retryAfter ?? computeWebhookBackoffMs(attempt)));
    }
    return { ok: false, code: "network_error" };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, code: aborted ? "timeout" : "network_error" };
  }
}
