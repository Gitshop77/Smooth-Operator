import { redactKeyLeak } from "@/lib/agent/redact-shared";
import type { LLMProvider } from "@/lib/agent/llm/provider";
import { buildProvider, type ProviderConfig } from "../provider-config";
import type {
  ProviderConnectionConfigV1,
  ProviderConnectionDiagnosticCode,
  ProviderConnectionResultV1,
} from "../options-platform-contract";
import { decodeCredentialReference, type CredentialReferenceV1 } from "../credential-contract";
import { resolveAndValidateLlmBaseUrl } from "@/lib/agent/llm/route/ssrf";

const CONNECTION_TIMEOUT_MS = 15_000;
const LOCAL_CONNECTION_TIMEOUT_MS = 5 * 60_000;
const CONNECTION_MAX_TOKENS = 8;
const CONNECTION_PROMPT = "Reply with OK.";

export type CredentialResolution =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "stale" | "unavailable" };

export interface ProviderConnectionDependencies {
  resolveCredential(reference: CredentialReferenceV1 | null): Promise<CredentialResolution>;
  buildProvider(config: ProviderConfig): Promise<LLMProvider>;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ProviderConnectionService {
  test(config: ProviderConnectionConfigV1, signal?: AbortSignal): Promise<ProviderConnectionResultV1>;
}

class ConnectionDeadlineError extends Error {
  constructor() {
    super("Connection test timed out");
    this.name = "ConnectionDeadlineError";
  }
}

class ConnectionCancelledError extends Error {
  constructor() {
    super("Connection test cancelled");
    this.name = "ConnectionCancelledError";
  }
}

function defaultDependencies(resolveCredential: ProviderConnectionDependencies["resolveCredential"]): ProviderConnectionDependencies {
  return {
    resolveCredential,
    buildProvider,
    now: Date.now,
    // Chromium Web APIs can enforce their native receiver. Storing the bare
    // functions here and later invoking `dependencies.setTimer(...)` binds
    // `this` to the dependencies object and throws "Illegal invocation" in
    // the MV3 worker (Node's timers happen to tolerate it, hiding the defect
    // from unit tests). Wrappers preserve an ordinary global invocation.
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (timer) => clearTimeout(timer),
    fetch: (input, init) => fetch(input, init),
  };
}

function sanitizedMessage(value: unknown, secret = ""): string {
  let message = value instanceof Error ? value.message : String(value);
  if (secret) message = message.split(secret).join("[REDACTED]");
  return redactKeyLeak(message).slice(0, 240);
}

function classifyFailure(error: unknown): ProviderConnectionDiagnosticCode {
  if (error instanceof ConnectionDeadlineError) return "timeout";
  if (error instanceof ConnectionCancelledError) return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/SSRF|redirect|blocked|canonical host|policy|DNS|private|loopback/i.test(message)) {
    return "policy_blocked";
  }
  return "provider_error";
}

/**
 * Observe an adapter promise without ever consuming a late value. `Promise.race`
 * installs rejection handlers on every input, and this explicit catch documents
 * and pins the non-cooperative-adapter contract: a stage that rejects after the
 * deadline/caller abort must not surface as an unhandled rejection.
 */
function suppressLateSettlement<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

function validConfig(config: ProviderConnectionConfigV1): boolean {
  return config?.version === 1 &&
    typeof config.provider === "string" && config.provider.trim().length > 0 &&
    typeof config.model === "string" &&
    (config.model.trim().length > 0 || config.provider === "ollama") &&
    (config.provenance === "user" || config.provenance === "injected") &&
    (config.baseUrl === undefined || typeof config.baseUrl === "string") &&
    (config.resourceName === undefined || typeof config.resourceName === "string") &&
    (config.contextTokens === undefined ||
      (Number.isSafeInteger(config.contextTokens) && config.contextTokens > 0));
}

/** Parse model ids from an OpenAI-compatible `/v1/models` response. */
export function parseOpenAIModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))];
}

function modelsUrl(baseUrl: string | undefined): string {
  const url = new URL(baseUrl || "http://localhost:11434/v1");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/models";
  return url.toString();
}

async function discoverLocalModel(
  config: ProviderConnectionConfigV1,
  dependencies: ProviderConnectionDependencies,
  signal: AbortSignal,
): Promise<string> {
  if (config.model.trim()) return config.model.trim();
  const url = modelsUrl(config.baseUrl);
  const provenance = config.provenance === "user" ? "user-configured" : "untrusted";
  const safe = await resolveAndValidateLlmBaseUrl(url, config.provenance === "user", provenance);
  if (!safe.ok) throw new Error(`Model discovery blocked: ${safe.reason}`);
  const response = await dependencies.fetch(url, {
    signal,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status})`);
  const ids = parseOpenAIModelIds(await response.json());
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) throw new Error("No models were returned by the local endpoint.");
  throw new Error(`The local endpoint returned ${ids.length} models. Select one in Agent settings.`);
}

interface LlamaCppProps {
  totalSlots: number;
  perSlotContext: number;
  vision: boolean;
}

/** Parse only the stable llama.cpp `/props` fields used by connection diagnostics. */
export function parseLlamaCppProps(payload: unknown): LlamaCppProps | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const generation = obj.default_generation_settings;
  const nCtx = generation && typeof generation === "object"
    ? (generation as Record<string, unknown>).n_ctx
    : undefined;
  if (!Number.isSafeInteger(obj.total_slots) || (obj.total_slots as number) < 1 ||
      !Number.isSafeInteger(nCtx) || (nCtx as number) < 1) return null;
  const modalities = obj.modalities;
  const vision = !!(modalities && typeof modalities === "object" &&
    (modalities as Record<string, unknown>).vision === true);
  return {
    totalSlots: obj.total_slots as number,
    perSlotContext: nCtx as number,
    vision,
  };
}

function llamaCppPropsUrl(baseUrl: string | undefined): string {
  const url = new URL(baseUrl || "http://localhost:11434/v1");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/props";
  return url.toString();
}

async function probeLlamaCpp(
  config: ProviderConnectionConfigV1,
  dependencies: ProviderConnectionDependencies,
  signal: AbortSignal,
): Promise<LlamaCppProps | null> {
  if (config.provider !== "ollama") return null;
  const url = llamaCppPropsUrl(config.baseUrl);
  const provenance = config.provenance === "user" ? "user-configured" : "untrusted";
  const safe = await resolveAndValidateLlmBaseUrl(url, config.provenance === "user", provenance);
  if (!safe.ok) return null;
  try {
    const response = await dependencies.fetch(url, { signal, redirect: "error" });
    if (!response.ok) return null; // Ordinary Ollama does not expose `/props`.
    return parseLlamaCppProps(await response.json());
  } catch (error) {
    if (signal.aborted) throw error;
    return null; // Capability discovery is best-effort; generation stays authoritative.
  }
}

export function createProviderConnectionService(
  resolveCredential: ProviderConnectionDependencies["resolveCredential"],
  dependencyOverrides: Partial<Omit<ProviderConnectionDependencies, "resolveCredential">> = {},
): ProviderConnectionService {
  const dependencies = { ...defaultDependencies(resolveCredential), ...dependencyOverrides };

  return {
    async test(config, signal) {
      const start = dependencies.now();
      const result = (
        ok: boolean,
        code: ProviderConnectionDiagnosticCode,
        message: string,
        resolvedModel = typeof config?.model === "string" ? config.model : "",
      ): ProviderConnectionResultV1 => ({
        version: 1,
        ok,
        code,
        latencyMs: Math.max(0, dependencies.now() - start),
        provider: typeof config?.provider === "string" ? config.provider : "",
        model: resolvedModel,
        message: message.slice(0, 240),
      });

      if (!validConfig(config)) return result(false, "invalid_config", "Provider and selected model are required.");

      let apiKey = "";
      let reference: CredentialReferenceV1 | null = null;
      if (config.credential !== null) {
        reference = decodeCredentialReference(config.credential);
        if (!reference) {
          return result(false, "credential_stale", "The saved credential reference is stale. Save the key again.");
        }
        if (reference.providerId !== config.provider) {
          return result(false, "credential_stale", "The saved credential belongs to a different provider. Save the key again.");
        }
      }
      if (signal?.aborted) {
        return result(false, "cancelled", "Connection test cancelled.");
      }

      let removeCredentialAbortListener: (() => void) | undefined;
      let resolution: CredentialResolution;
      try {
        const credentialPromise = suppressLateSettlement(dependencies.resolveCredential(reference));
        if (signal) {
          const abortPromise = new Promise<never>((_, reject) => {
            const onAbort = () => reject(new ConnectionCancelledError());
            removeCredentialAbortListener = () => signal.removeEventListener("abort", onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
          resolution = await Promise.race([credentialPromise, abortPromise]);
        } else {
          resolution = await credentialPromise;
        }
      } catch (error) {
        if (error instanceof ConnectionCancelledError) {
          return result(false, "cancelled", "Connection test cancelled.");
        }
        resolution = { ok: false, reason: "unavailable" };
      } finally {
        removeCredentialAbortListener?.();
      }
      if (resolution.ok) {
        apiKey = resolution.value;
      } else if (reference !== null) {
          return result(false, "credential_stale", "The saved credential is unavailable or stale. Save the key again.");
      }

      const controller = new AbortController();
      let rejectDeadline!: (error: ConnectionDeadlineError) => void;
      const deadlinePromise = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const connectionTimeoutMs = config.provider === "ollama"
        ? LOCAL_CONNECTION_TIMEOUT_MS
        : CONNECTION_TIMEOUT_MS;
      const timer = dependencies.setTimer(() => {
        const error = new ConnectionDeadlineError();
        controller.abort(error);
        rejectDeadline(error);
      }, connectionTimeoutMs);

      let removeCallerAbortListener: (() => void) | undefined;
      let rejectCallerAbort: ((error: ConnectionCancelledError) => void) | undefined;
      const callerAbortPromise = signal
        ? new Promise<never>((_, reject) => {
            rejectCallerAbort = reject;
            const onAbort = () => {
              const error = new ConnectionCancelledError();
              controller.abort(error);
              rejectCallerAbort?.(error);
            };
            removeCallerAbortListener = () => signal.removeEventListener("abort", onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          })
        : null;
      const awaitStage = <T>(stage: Promise<T>): Promise<T> => Promise.race([
        suppressLateSettlement(stage),
        deadlinePromise,
        ...(callerAbortPromise ? [callerAbortPromise] : []),
      ]);
      try {
        const effectiveModel = config.provider === "ollama"
          ? await awaitStage(discoverLocalModel(config, dependencies, controller.signal))
          : config.model;
        const provider = await awaitStage(dependencies.buildProvider({
          provider: config.provider,
          model: effectiveModel,
          apiKey,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.resourceName ? { resourceName: config.resourceName } : {}),
          provenance: config.provenance,
        }));
        const llamaCpp = await awaitStage(probeLlamaCpp(config, dependencies, controller.signal));
        if (llamaCpp && config.contextTokens && config.contextTokens > llamaCpp.perSlotContext) {
          return result(
            false,
            "context_mismatch",
            `llama.cpp exposes ${llamaCpp.totalSlots} slot${llamaCpp.totalSlots === 1 ? "" : "s"} × ` +
              `${llamaCpp.perSlotContext} context; configured ${config.contextTokens} exceeds each slot. ` +
              `Reduce parallel slots or lower the context override.`,
            effectiveModel,
          );
        }
        await awaitStage(provider.chat({
          messages: [{ role: "user", content: CONNECTION_PROMPT }],
          maxTokens: CONNECTION_MAX_TOKENS,
          signal: controller.signal,
        }));
        const detail = llamaCpp
          ? ` llama.cpp: ${llamaCpp.totalSlots} slot${llamaCpp.totalSlots === 1 ? "" : "s"} × ` +
            `${llamaCpp.perSlotContext} context${llamaCpp.vision ? ", vision" : ""}.`
          : "";
        const discovered = !config.model.trim()
          ? ` Auto-selected the only server model: ${effectiveModel}.`
          : "";
        return {
          ...result(
            true,
            "ok",
            `Connected to ${config.provider} with ${effectiveModel}.${detail}${discovered}`,
            effectiveModel,
          ),
          ...(llamaCpp ? {
            contextTokens: llamaCpp.perSlotContext,
            slots: llamaCpp.totalSlots,
            vision: llamaCpp.vision,
          } : {}),
        };
      } catch (error) {
        const code = classifyFailure(error);
        return result(false, code, sanitizedMessage(error, apiKey));
      } finally {
        dependencies.clearTimer(timer);
        removeCallerAbortListener?.();
        apiKey = "";
      }
    },
  };
}
