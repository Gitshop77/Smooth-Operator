/**
 * Route client — composable route factory.
 *
 * A Route binds a protocol (API format) to an endpoint (URL), auth (credentials),
 * and transport (HTTP). `route.model({ id })` produces a runnable model.
 *
 * Plain TypeScript — no framework dependencies.
 */

import { Auth, type AuthStrategy as AuthDef } from "./auth";
import { type Endpoint } from "./endpoint";
import { type Framing } from "./framing";
import { type Transport, httpJson, type HttpPrepared } from "./transport-http";
import type { SsrfProvenance } from "./ssrf";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteBody<Body> {
  /** Build the provider-native body from a common LLMRequest. */
  readonly from: (request: LLMRequest) => Body | Promise<Body>;
}

export interface Protocol<Body = unknown, FrameType = string, EventType = unknown, State = unknown> {
  readonly id: string;
  readonly body: RouteBody<Body>;
  readonly stream: {
    readonly initial: (request: LLMRequest) => State;
    readonly step: (state: State, frame: FrameType) => { state: State; events: EventType[] };
    readonly terminal?: (frame: FrameType, state?: State) => boolean;
    /**
     * Return safe, aggregate evidence about how a stream ended. Protocols must
     * never put model reasoning, prompt text, page data, or credentials here.
     */
    readonly completion?: (state: State) => StreamCompletionEvidence | undefined;
  };
}

/** Safe protocol evidence used to classify a terminal stream outcome. */
export interface StreamCompletionEvidence {
  /** Whether the provider emitted a reasoning/thinking-only field. */
  readonly reasoningObserved?: boolean;
  /** Aggregate provider-reported reasoning tokens, if available. */
  readonly reasoningTokens?: number;
  /** Provider terminal reason, retained only as a short machine-readable tag. */
  readonly finishReason?: string;
  /** Number of malformed/non-JSON provider frames intentionally dropped. */
  readonly droppedFrames?: number;
}

export type LLMTerminalDiagnosticCode =
  | "empty_visible_output"
  | "reasoning_only"
  | "reasoning_budget_exhausted"
  | "malformed_stream"
  | "no_terminal_stream";

/**
 * Additive, non-sensitive completion diagnosis. Generic callers may continue
 * to consume `content`; direct agent calls turn this into an actionable error.
 */
export interface LLMTerminalDiagnostic extends StreamCompletionEvidence {
  readonly code: LLMTerminalDiagnosticCode;
  readonly protocol: string;
  readonly visibleContentChars: number;
  readonly terminalSeen: boolean;
}

/** Typed error used by direct agent calls for unusable provider completions. */
export class LLMTerminalDiagnosticError extends Error {
  readonly diagnostic: LLMTerminalDiagnostic;
  readonly code: string;
  readonly recovery: string;
  usage?: {
    raw: string;
    tokensIn?: number;
    tokensOut?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    model?: string;
    costUsd?: number;
  };

  constructor(diagnostic: LLMTerminalDiagnostic) {
    const reasoningOnly = diagnostic.code === "reasoning_only" || diagnostic.code === "reasoning_budget_exhausted";
    const protocolFailure = diagnostic.code === "malformed_stream" || diagnostic.code === "no_terminal_stream";
    super(
      reasoningOnly
        ? "The model used its response for reasoning but returned no visible answer."
        : protocolFailure
          ? "The provider stream ended before a complete answer could be read."
          : "The model returned no visible answer.",
    );
    this.name = "LLMTerminalDiagnosticError";
    this.diagnostic = diagnostic;
    this.code = reasoningOnly
      ? "REASONING_ONLY_OUTPUT"
      : protocolFailure
        ? "PROTOCOL_STREAM_ERROR"
        : "EMPTY_MODEL_OUTPUT";
    this.recovery = diagnostic.code === "reasoning_budget_exhausted"
      ? "Increase the model output budget or choose a non-reasoning model, then retry."
      : protocolFailure
        ? "Retry once; if this repeats, test the connection or choose a different provider/model."
        : "Retry once or choose a different provider/model. No browser action was started from this response.";
  }
}

interface Route<Body = unknown, Prepared = unknown> {
  readonly endpoint: Endpoint<Body>;
  readonly auth: AuthDef;
  readonly body: RouteBody<Body>;
  readonly model: (input: { id: string; provider?: string }) => Model;
  readonly streamPrepared: (prepared: Prepared, request: LLMRequest, signal?: AbortSignal) => AsyncIterable<unknown>;
  readonly prepareTransport: (body: Body, request: LLMRequest) => Prepared;
}

/**
 * A `Model` is the serializable handle carried on an `LLMRequest`. It deliberately
 * contains NO functions and NO reference to the (function-valued) `Route` — only the
 * `routeId` needed to resolve the live `Route` from the module-level `routeRegistry`
 * on the side that executes the request. This keeps `LLMRequest` safe to pass across
 * `chrome.runtime`/`postMessage` boundaries (structured clone), which would otherwise
 * throw `DataCloneError` on the circular `route` reference and its closures, and would
 * recurse infinitely under `JSON.stringify`.
 */
interface Model {
  readonly id: string;
  readonly provider: string;
  readonly routeId: string;
}

/**
 * Registry mapping a stable route key to its (function-valued) live `Route`.
 * Routes are registered when constructed via `make`/`makeFromTransport`; `generate`
 * resolves the executable route from a `Model.routeId` through this registry instead
 * of carrying the route on the request payload. Both the producer and consumer contexts
 * import the same route definitions (via the provider modules), so the keys line up
 * across the message-passing boundary.
 */
const routeRegistry = new Map<string, Route<unknown, unknown>>();

/** Cap on registered routes — a long-lived service worker with provider churn
 * (re-configures, many models/endpoints/credentials) would otherwise grow this
 * map without bound. Routes are re-registered on every `make()`/configure
 * call, so FIFO eviction of the OLDEST entry only drops a route whose model
 * handle was created before the most recent re-configure of that key; the next
 * `generate()` for that key re-registers it through the normal provider
 * bootstrap. Minimal max-size eviction — no LRU library. */
const ROUTE_REGISTRY_MAX = 256;

interface GenerationOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
}

export interface LLMRequest {
  readonly model: Model;
  readonly messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
  readonly generation?: GenerationOptions;
  readonly providerOptions?: Record<string, unknown>;
  readonly schema?: unknown;
  /**
   * When true, the provider handles a reasoning/thinking model that rejects
   * `temperature` (and `frequency_penalty`) and expects `max_completion_tokens`
   * instead of `max_tokens`. Protocols omit those params accordingly.
   */
  readonly reasoning?: boolean;
  /**
   * Per-request reasoning configuration: effort level, thinking budget in
   * tokens, and a force on/off switch. Protocols only act on it when
   * `reasoning` is also true (the provider is a reasoning model), so
   * non-reasoning providers keep today's exact request shape.
   */
  readonly reasoningConfig?: {
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly enabled?: boolean;
  };
  /**
   * True when the caller expects the same prompt to be reused across calls
   * (prompt-cache friendly). Protocols may omit cache markers for one-shot
   * requests that never re-read them.
   */
  readonly cacheEligible?: boolean;
  /**
   * When true, request OpenAI "strict" JSON-schema structured output
   * (`response_format: { type: "json_schema", strict: true }`). When false
   * (or unset and the protocol defaults to non-strict), fall back to
   * `response_format: { type: "json_object" }` and rely on the in-prompt
   * schema contract — required for OpenAI-compatible providers that 400 on
   * strict mode (DeepSeek, Ollama, Qwen, Fireworks, …).
   */
  readonly structuredOutputStrict?: boolean;
}

interface LLMResponse {
  readonly content: string;
  readonly usage?: {
    tokensIn: number;
    tokensOut: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    /** Cache-creation tokens (Anthropic) — billed at the cacheWrite rate. */
    cachedWriteInputTokens?: number;
    model: string;
    costUsd: number;
  };
  /** Present only when the stream completed with unusable/suspect output. */
  readonly terminalDiagnostic?: LLMTerminalDiagnostic;
}

function isBudgetLikeFinishReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /(?:length|max[_ -]?tokens?|token[_ -]?limit|reasoning|budget)/i.test(reason);
}

function classifyCompletion(params: {
  protocol: string;
  terminalSeen: boolean;
  visibleContentChars: number;
  hasVisibleNonWhitespace: boolean;
  evidence?: StreamCompletionEvidence;
}): LLMTerminalDiagnostic | undefined {
  const { protocol, terminalSeen, visibleContentChars, hasVisibleNonWhitespace, evidence } = params;
  const droppedFrames = evidence?.droppedFrames ?? 0;
  if (droppedFrames > 0) {
    return {
      code: "malformed_stream",
      protocol,
      visibleContentChars,
      terminalSeen,
      ...(evidence ?? {}),
    };
  }
  if (!terminalSeen) {
    return {
      code: "no_terminal_stream",
      protocol,
      visibleContentChars,
      terminalSeen: false,
      ...(evidence ?? {}),
    };
  }
  if (hasVisibleNonWhitespace) return undefined;

  const reasoningObserved = evidence?.reasoningObserved === true || (evidence?.reasoningTokens ?? 0) > 0;
  const code: LLMTerminalDiagnosticCode = reasoningObserved
    ? (isBudgetLikeFinishReason(evidence?.finishReason)
      ? "reasoning_budget_exhausted"
      : "reasoning_only")
    : "empty_visible_output";
  return {
    code,
    protocol,
    visibleContentChars,
    terminalSeen: true,
    ...(evidence ?? {}),
  };
}

// ─── Route factory ────────────────────────────────────────────────────────────

interface MakeRouteInput<Body, FrameType, EventType, State> {
  readonly id: string;
  readonly provider?: string;
  readonly protocol: Protocol<Body, FrameType, EventType, State>;
  readonly endpoint: Endpoint<Body>;
  readonly auth?: AuthDef;
  readonly framing: Framing<FrameType>;
  readonly headers?: Record<string, string>;
  /**
   * Provenance of the base URL this route will fetch. Threaded into the SSRF
   * guards so an injected / non-user URL FAILS CLOSED. Defaults to
   * `"untrusted"`; pass `"user-configured"` only for a URL the user explicitly
   * configured. The curated Ollama / LiteLLM loopback origins are only treated
   * as `user-configured` when the caller explicitly passes that flag — they are
   * never upgraded automatically.
   */
  readonly provenance?: SsrfProvenance;
}

export function make<Body, FrameType, EventType, State>(
  input: MakeRouteInput<Body, FrameType, EventType, State>
): Route<Body, HttpPrepared<FrameType>> {
  const transport = httpJson<Body, FrameType>({
    framing: input.framing,
    provenance: input.provenance,
    providerId: input.provider,
  });
  return makeFromTransport({
    ...input,
    transport,
  });
}

function makeFromTransport<Body, Prepared, FrameType, EventType, State>(
  input: MakeRouteInput<Body, FrameType, EventType, State> & { transport: Transport<Body, Prepared, FrameType> }
): Route<Body, Prepared> {
  const protocol = input.protocol;
  const encodeBody = (body: Body): string => JSON.stringify(body);

  const routeId = `${input.provider ?? input.id}::${input.id}`;
  const route: Route<Body, Prepared> = {
    endpoint: input.endpoint,
    auth: input.auth ?? Auth.none,
    body: protocol.body,
    model: (modelInput: { id: string; provider?: string }): Model => ({
      id: modelInput.id,
      provider: modelInput.provider ?? input.provider ?? input.id,
      routeId,
    }),
    prepareTransport: (body: Body, _request: LLMRequest): Prepared =>
      input.transport.prepare({
        body,
        endpoint: input.endpoint,
        auth: input.auth ?? Auth.none,
        encodeBody,
        headers: input.headers,
      }),
    streamPrepared: async function* (prepared: Prepared, request: LLMRequest, signal?: AbortSignal): AsyncIterable<unknown> {
      let state = protocol.stream.initial(request);
      let finishUsage: unknown;
      let terminalSeen = false;
      let visibleContentChars = 0;
      let hasVisibleNonWhitespace = false;
      let framesSeen = 0;
      for await (const frame of input.transport.frames(prepared, signal)) {
        framesSeen++;
        const { state: newState, events } = protocol.stream.step(state, frame as FrameType);
        state = newState;
        for (const event of events) {
          const eventLike = event as { type?: string; content?: string; usage?: unknown };
          if (eventLike.type === "finish") {
            finishUsage = eventLike.usage;
            continue;
          }
          if (eventLike.type === "text" && eventLike.content) {
            visibleContentChars += eventLike.content.length;
            if (eventLike.content.trim().length > 0) hasVisibleNonWhitespace = true;
          }
          yield event;
        }
        if (protocol.stream.terminal?.(frame as FrameType, state)) {
          terminalSeen = true;
          break;
        }
      }
 // Emit exactly one finish event after the stream ends so it can carry a
 // normalized terminal diagnosis for every protocol. Abort errors are thrown
 // by the transport before reaching this point and therefore preserve their
 // native AbortError identity.
 //
 // A clean EOF after at least one data frame is a NORMAL terminal event: some
 // providers (and transparent proxies) close the stream without the literal
 // `[DONE]`/`message_stop` sentinel, and mislabeling that as
 // `no_terminal_stream` turned a healthy completion into a hard failure.
 // Truncated streams are still caught elsewhere: a frame cut mid-stream
 // surfaces as `malformed_stream` (via droppedFrames), and a transport stall /
 // abort throws before this point. Only a stream that ended with ZERO frames
 // (no terminal evidence at all) is still reported as `no_terminal_stream`.
      const completion = classifyCompletion({
        protocol: protocol.id,
        terminalSeen: terminalSeen || framesSeen > 0,
        visibleContentChars,
        hasVisibleNonWhitespace,
        evidence: protocol.stream.completion?.(state),
      });
      yield {
        type: "finish",
        usage: finishUsage ?? (state as { usage?: unknown }).usage,
        ...(completion ? { terminalDiagnostic: completion } : {}),
      };
    },
  };
  if (routeRegistry.size >= ROUTE_REGISTRY_MAX) {
    const oldest = routeRegistry.keys().next().value;
    if (oldest !== undefined) routeRegistry.delete(oldest);
  }
  routeRegistry.set(routeId, route as Route<unknown, unknown>);
  return route;
}

// ─── High-level generate (non-streaming convenience) ──────────────────────────

/** Run a model to completion, returning the full response. */
export async function generate(
  request: LLMRequest,
  signal?: AbortSignal
): Promise<LLMResponse> {
  if (signal?.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  const route = routeRegistry.get(request.model.routeId);
  if (!route) {
 // This is almost always a module-load-order problem, not a provider/auth
 // failure: the route for this model was never imported in the current
 // execution context (service worker vs. sidepanel vs. offscreen doc). Route
 // registration is a side effect of importing the provider's route
 // definitions, so the caller must ensure the matching provider module
 // (e.g. `openai`, `anthropic`) has been imported here before calling
 // `generate`. It is NOT a 4xx/5xx from the model provider.
    throw new Error(
      `No route registered for model "${request.model.provider}/${request.model.id}" (routeId "${request.model.routeId}"). ` +
        `This means the matching provider/route module was not imported in this execution context — ` +
        `import the provider's route definitions before generating, rather than treating this as a provider error.`
    );
  }
  const body = await route.body.from(request);
  const prepared = route.prepareTransport(body, request);
  const chunks: string[] = [];
  let usage: LLMResponse["usage"] | undefined;
  let terminalDiagnostic: LLMTerminalDiagnostic | undefined;
  for await (const event of route.streamPrepared(prepared, request, signal)) {
    const e = event as {
      type: string;
      content?: string;
      usage?: LLMResponse["usage"];
      terminalDiagnostic?: LLMTerminalDiagnostic;
    };
    if (e.type === "text" && e.content) chunks.push(e.content);
    if (e.type === "finish" && e.usage) usage = e.usage;
    if (e.type === "finish" && e.terminalDiagnostic) terminalDiagnostic = e.terminalDiagnostic;
  }
  return {
    content: chunks.join(""),
    usage,
    ...(terminalDiagnostic ? { terminalDiagnostic } : {}),
  };
}
