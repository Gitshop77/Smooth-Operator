//
// POST /api/cowork/ai/chat
//   Body: { messages: ChatMessage[], systemPrompt?: string, sessionId?: string, stream?: boolean, thinking?: 'enabled'|'disabled' }
//   Forwards to the cowork-events mini-service at http://localhost:3003/chat
//   which uses z-ai-web-dev-sdk to generate a completion.
//
// The mini-service streams tokens to socket.io room `sessionId` while the
// request is in flight; this route returns the final assembled text as JSON.
// (Browser clients should subscribe to the `chat:message` socket.io channel
// for live token streaming.)
//
// Per project rules, server-to-server fetches may use `http://localhost:3003`
// directly — the mini-service is internal and not exposed through Caddy.

import type { NextRequest } from 'next/server';
import { json, badRequest, serverError, withRouteError } from '@/lib/cowork/api/http';
import { COWORK_EVENTS_BASE, COWORK_EVENTS_TOKEN } from '@/lib/cowork/events/client';

interface ChatProxyBody {
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  sessionId?: string;
  stream?: boolean;
  thinking?: 'enabled' | 'disabled';
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    let body: ChatProxyBody;
    try {
      body = (await req.json()) as ChatProxyBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return badRequest('messages[] required');
    }
    // Cap array length + per-field size so an authenticated caller can't
    // DoS the mini-service (or run up token billing) with a 10k-message
    // payload or 10MB single messages. Limits are generous enough for real
    // chat history but block obvious abuse.
    if (body.messages.length > 100) {
      return badRequest('messages[] must contain at most 100 entries');
    }
    for (const m of body.messages) {
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
        return badRequest('each message must have { role, content }');
      }
      // Validate role against the literal union — an authenticated caller
      // could forward arbitrary roles (e.g. 'developer', 'tool') to the
      // z-ai SDK. Defense-in-depth: the SDK may reject unknown roles, but
      // don't rely on downstream validation.
      if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') {
        return badRequest('each message.role must be "system", "user", or "assistant"');
      }
      if (m.content.length > 32_000) {
        return badRequest('each message.content must be at most 32KB');
      }
    }
    if (body.systemPrompt !== undefined) {
      if (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 16_000) {
        return badRequest('systemPrompt must be a string of at most 16KB');
      }
    }
    if (body.sessionId !== undefined) {
      if (typeof body.sessionId !== 'string' || body.sessionId.length > 128) {
        return badRequest('sessionId must be a string of at most 128 chars');
      }
    }

    // SECURITY NOTE (F-44): this is a chat *proxy*. The `messages` array is
    // forwarded to the upstream LLM verbatim — user/assistant content is
    // inherently untrusted and must be processed as-is by the model, so no
    // sanitization is performed here. If untrusted content is ever mixed into
    // a *server-controlled* `history`/system context (rather than passed by
    // the caller), pin a fixed server-side system prompt and keep caller
    // content in the `user` role only, to avoid indirect prompt injection.
    // A caller-supplied `system` role or `systemPrompt` is intentionally
    // forwarded as-is (it is a chat proxy, not a trusted orchestrator).

    const sessionId = body.sessionId || `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: ChatProxyBody = {
      messages: body.messages,
      systemPrompt: body.systemPrompt,
      sessionId,
      stream: body.stream !== false, // default: stream via socket.io
      thinking: body.thinking,
    };

    let upstream: Response;
    try {
      upstream = await fetch(`${COWORK_EVENTS_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cowork-Token': COWORK_EVENTS_TOKEN },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return serverError(`cowork-events unreachable: ${msg}`);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return serverError(`cowork-events /chat ${upstream.status}: ${text.slice(0, 200)}`);
    }

    // Forward the upstream JSON verbatim — it already has the shape
    // { ok, sessionId, content, streamed }.
    const data = await upstream.json();
    return json(data);
  });
}

export async function GET(): Promise<Response> {
  return json({
    route: '/api/cowork/ai/chat',
    method: 'POST',
    body: {
      messages: 'Array<{ role: "system"|"user"|"assistant", content: string }>',
      systemPrompt: 'string (optional)',
      sessionId: 'string (optional — used as socket.io room for streaming)',
      stream: 'boolean (default true — also streams tokens to chat:message socket.io channel)',
      thinking: '"enabled" | "disabled" (default disabled)',
    },
    upstream: `${COWORK_EVENTS_BASE}/chat`,
  });
}
