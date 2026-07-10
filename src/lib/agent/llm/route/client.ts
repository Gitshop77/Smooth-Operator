/**
 * Route client — composable route factory.
 *
 * A Route binds a protocol (API format) to an endpoint (URL), auth (credentials),
 * and transport (HTTP). `route.model({ id })` produces a runnable model.
 *
 * Plain TypeScript — no framework dependencies.
 */

import { Auth, type Auth as AuthDef } from "./auth";
import { type Endpoint } from "./endpoint";
import { type Framing } from "./framing";
import { type Transport, httpJson, type HttpPrepared } from "./transport-http";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteBody<Body> {
  /** Build the provider-native body from a common LLMRequest. */
  readonly from: (request: LLMRequest) => Body | Promise<Body>;
}

export interface Protocol<Body = unknown, FrameType = string, EventType = unknown, State = unknown> {
  readonly id: string;
  readonly body: RouteBody<Body>;
  readonly stream: {
    readonly initial: (request: LLMRequest) => State;
    readonly step: (state: State, frame: FrameType) => { state: State; events: EventType[] };
    readonly terminal?: (frame: FrameType) => boolean;
  };
}

export interface Route<Body = unknown, Prepared = unknown> {
  readonly endpoint: Endpoint<Body>;
  readonly auth: AuthDef;
  readonly body: RouteBody<Body>;
  readonly model: (input: { id: string; provider?: string }) => Model;
  readonly streamPrepared: (prepared: Prepared, request: LLMRequest, signal?: AbortSignal) => AsyncIterable<unknown>;
  readonly prepareTransport: (body: Body, request: LLMRequest) => Prepared;
}

export interface Model {
  readonly id: string;
  readonly provider: string;
  readonly route: Route;
}

export interface GenerationOptions {
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
}

export interface LLMResponse {
  readonly content: string;
  readonly usage?: {
    tokensIn: number;
    tokensOut: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    model: string;
    costUsd: number;
  };
}

// ─── Route factory ────────────────────────────────────────────────────────────

export interface MakeRouteInput<Body, FrameType, EventType, State> {
  readonly id: string;
  readonly provider?: string;
  readonly protocol: Protocol<Body, FrameType, EventType, State>;
  readonly endpoint: Endpoint<Body>;
  readonly auth?: AuthDef;
  readonly framing: Framing<FrameType>;
  readonly headers?: Record<string, string>;
}

export function make<Body, FrameType, EventType, State>(
  input: MakeRouteInput<Body, FrameType, EventType, State>
): Route<Body, HttpPrepared<FrameType>> {
  const transport = httpJson<FrameType>({ framing: input.framing });
  return makeFromTransport({
    ...input,
    transport: transport as unknown as Transport<Body, HttpPrepared<FrameType>, FrameType>,
  });
}

function makeFromTransport<Body, Prepared, FrameType, EventType, State>(
  input: MakeRouteInput<Body, FrameType, EventType, State> & { transport: Transport<Body, Prepared, FrameType> }
): Route<Body, Prepared> {
  const protocol = input.protocol;
  const encodeBody = (body: Body): string => JSON.stringify(body);

  const route: Route<Body, Prepared> = {
    endpoint: input.endpoint,
    auth: input.auth ?? Auth.none,
    body: protocol.body,
    model: (modelInput: { id: string; provider?: string }): Model => ({
      id: modelInput.id,
      provider: modelInput.provider ?? input.provider ?? input.id,
      route: route as unknown as Route,
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
        if (protocol.stream.terminal?.(frame as FrameType)) {
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
  return route;
}

// ─── High-level generate (non-streaming convenience) ──────────────────────────

/** Run a model to completion, returning the full response. */
export async function generate(
  request: LLMRequest,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const route = request.model.route;
  const body = await route.body.from(request);
  const prepared = route.prepareTransport(body, request);
  let content = "";
  let usage: LLMResponse["usage"] | undefined;
  for await (const event of route.streamPrepared(prepared, request, signal)) {
    const e = event as { type: string; content?: string; usage?: LLMResponse["usage"] };
    if (e.type === "text" && e.content) content += e.content;
    if (e.type === "finish" && e.usage) usage = e.usage;
  }
  return { content, usage };
}
