import { redactKeyLeak } from "@/lib/agent/redact-shared";
import type { LLMProvider } from "@/lib/agent/llm/provider";
import { buildProvider, type ProviderConfig } from "../provider-config";
import type {
  ProviderConnectionConfigV1,
  ProviderConnectionDiagnosticCode,
  ProviderConnectionResultV1,
} from "../options-platform-contract";
import { decodeCredentialReference, type CredentialReferenceV1 } from "../credential-contract";

const CONNECTION_TIMEOUT_MS = 15_000;
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
    setTimer: setTimeout,
    clearTimer: clearTimeout,
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
    typeof config.model === "string" && config.model.trim().length > 0 &&
    (config.provenance === "user" || config.provenance === "injected") &&
    (config.baseUrl === undefined || typeof config.baseUrl === "string") &&
    (config.resourceName === undefined || typeof config.resourceName === "string");
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
      ): ProviderConnectionResultV1 => ({
        version: 1,
        ok,
        code,
        latencyMs: Math.max(0, dependencies.now() - start),
        provider: typeof config?.provider === "string" ? config.provider : "",
        model: typeof config?.model === "string" ? config.model : "",
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
      const timer = dependencies.setTimer(() => {
        const error = new ConnectionDeadlineError();
        controller.abort(error);
        rejectDeadline(error);
      }, CONNECTION_TIMEOUT_MS);

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
        const provider = await awaitStage(dependencies.buildProvider({
          provider: config.provider,
          model: config.model,
          apiKey,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.resourceName ? { resourceName: config.resourceName } : {}),
          provenance: config.provenance,
        }));
        await awaitStage(provider.chat({
          messages: [{ role: "user", content: CONNECTION_PROMPT }],
          maxTokens: CONNECTION_MAX_TOKENS,
          signal: controller.signal,
        }));
        return result(true, "ok", `Connected to ${config.provider} with ${config.model}.`);
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
