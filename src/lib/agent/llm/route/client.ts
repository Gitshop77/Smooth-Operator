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
  };
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
      let emittedFinish = false;
      for await (const frame of input.transport.frames(prepared, signal)) {
        const { state: newState, events } = protocol.stream.step(state, frame as FrameType);
        state = newState;
        for (const event of events) {
          if ((event as { type?: string }).type === "finish") emittedFinish = true;
          yield event;
        }
        if (protocol.stream.terminal?.(frame as FrameType, state)) {
          break;
        }
      }
 // If the protocol's `step` never emitted a `finish` event (truncated/
 // aborted streams, or Gemini whose step never emits finish), synthesize
 // one so `generate()` receives the accumulated usage.
      if (!emittedFinish) {
        yield { type: "finish", usage: (state as { usage?: unknown }).usage };
      }
    },
  };
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
  for await (const event of route.streamPrepared(prepared, request, signal)) {
    const e = event as { type: string; content?: string; usage?: LLMResponse["usage"] };
    if (e.type === "text" && e.content) chunks.push(e.content);
    if (e.type === "finish" && e.usage) usage = e.usage;
  }
  return { content: chunks.join(""), usage };
}
