"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";

import type {
  SampleTab, SampleWorkspace, SampleAgent, SampleTask, SampleWorkflow,
  SampleSecurityEvent,
  SampleSession, SampleExtension, SampleSiteMemoryEntry, SampleFormMemoryEntry,
  SampleMcpTool, SampleBookmark, SampleHistoryEntry, SamplePinboard,
} from "@/lib/cowork-data/types";

/**
 * TanStack Query hooks for the Cowork Cockpit views.
 *
 * Each hook fetches from a real /api/cowork/<view> route. If the backend
 * returns an empty array the UI shows an empty state — we never fabricate
 * sample data. On fetch failure the query is marked `isError` so the view
 * can render an error/empty state. Hooks that wrap an array also expose an
 * empty array via `data ?? []` so list consumers do not crash.
 */

const TQ = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  // Retry once on transient failures only: 5xx or a transport error
  // (status === undefined). A 4xx (e.g. 401 auth) is terminal. The status is
  // attached to the thrown error in parseApiResponse.
  retry: (failureCount: number, error: unknown): boolean => {
    const status = (error as { status?: number } | null)?.status;
    return (status == null || status >= 500) && failureCount < 1;
  },
} as const;

/**
 * The X-Cowork-Token sent on every cockpit REST fetch. It is taken ONLY from
 * the browser-facing `NEXT_PUBLIC_COWORK_UI_TOKEN`. We accept no fallback:
 * - Dropping the legacy `NEXT_PUBLIC_COWORK_EVENT_TOKEN` fallback removes the
 * S2S-leak path: that name shadows the service-to-service
 * `COWORK_EVENT_TOKEN`, and mirroring its value would embed the secret in
 * public JS.
 * - Dropping the `dev-token` literal avoids shipping a hard-coded credential in
 * the client bundle and avoids silently sending a token the server rejects in
 * production (broken-but-not-obvious).
 * This MUST match the server-side `COWORK_UI_TOKEN` resolved by middleware.ts.
 * The `NEXT_PUBLIC_` prefix exposes this to the browser, so it must NEVER equal
 * the service-to-service `COWORK_EVENT_TOKEN` on any untrusted network.
 */
// When `NEXT_PUBLIC_COWORK_UI_TOKEN` is unset, fall back to the built-in
// `dev-token` ONLY in non-production (zero-config localhost dev). In production
// builds the fallback is omitted so a missing token fails closed — no
// well-known shared secret is shipped to clients or sent on untrusted networks.
// This MUST match the server-side secret resolved by middleware.ts.
const COWORK_TOKEN =
  process.env.NEXT_PUBLIC_COWORK_UI_TOKEN ??
  (process.env.NODE_ENV === "production" ? undefined : "dev-token");

// Fail loud on a missing UI token: warn at module load so the operator knows
// to set `NEXT_PUBLIC_COWORK_UI_TOKEN` rather than hitting opaque auth failures.
if (typeof window !== "undefined" && !COWORK_TOKEN) {
  console.error(
    "[cowork] NEXT_PUBLIC_COWORK_UI_TOKEN is not set — cockpit API calls will be " +
      "unauthorized. Set COWORK_UI_TOKEN (and its NEXT_PUBLIC_ mirror) in your environment.",
  );
}

/**
 * Headers every cockpit fetch must send (auth + accept).
 *
 * The `X-Cowork-Token` is only attached when it is actually defined. Sending an
 * explicit `undefined` header value is not a valid `HeadersInit` and throws a
 * `TypeError`, so we spread it conditionally. This preserves the auth mechanism
 * (the token is still sent whenever `NEXT_PUBLIC_COWORK_UI_TOKEN` is set) while
 * avoiding a broken-but-not-obvious `undefined` header when it is not.
 */
const JSON_HEADERS: HeadersInit = {
  accept: "application/json",
  ...(COWORK_TOKEN ? { "X-Cowork-Token": COWORK_TOKEN } : {}),
};

/**
 * Mask likely-secret material in a server error-body snippet before it is
 * embedded in a client-visible Error.message.
 *
 * Cockpit 5xx JSON error bodies can carry internal details (DB connection
 * strings with credentials, echoed tokens, config-bearing stack traces).
 * Surfacing that verbatim in the browser console / dashboard toast is an
 * information-disclosure risk, so we strip secret-shaped values before they
 * leave the server boundary. The status + statusText are always retained (see
 * parseApiResponse) so callers can still branch on the HTTP code.
 */
export function redactErrorSnippet(text: string): string {
  let out = text;
  // URL credentials: preserve the username (or an empty user), redact only the
  // password — even when the password itself embeds an `@`.
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^:@\s]*):(.*)@([^@\s]+)/gi,
    (_m, scheme: string, user: string, _pass: string, host: string) =>
      `${scheme}${user}:***@${host}`,
  );
  // Bearer / Basic credentials.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
  // key=value secrets (also matches single-quoted / unquoted values).
  out = out.replace(
    /(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)=(?:'[^']*'|"[^"]*"|[^&\s"'<>]+)/gi,
    "$1=***",
  );
  // "key": "value" JSON-shaped secrets (value fully redacted; also single-quoted).
  out = out.replace(
    /"(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)"\s*:\s*(?:"[^"]*"|'[^']*')/gi,
    '"$1":"***"',
  );
  // key: "value" (colon form) secrets — e.g. token: "x" (also single-quoted).
  out = out.replace(
    /(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)\s*:\s*(?:"[^"]*"|'[^']*')/gi,
    '$1: "***"',
  );
  // Well-known standalone credential literals.
  out = out.replace(
    /\b(gsk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20})\b/g,
    "***",
  );
  // Bare high-entropy scalars (no `/` so URL paths are not caught).
  out = out.replace(
    /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{20,}(?![A-Za-z0-9+_-])/g,
    "***",
  );
  return out;
}

/**
 * Validate a fetch `Response` and parse its body into `T`.
 *
 * This is the single choke-point for ALL cockpit API reads (REST list hooks
 * via `getJson`, and the chat POST via `useSendChat`). It enforces:
 * 1. HTTP success (`r.ok`) — otherwise throw with the status + a body
 * snippet so failures are actionable rather than opaque.
 * 2. `Content-Type: application/json` — an HTML error page or gateway
 * response is rejected rather than blindly `JSON.parse`'d.
 * 3. A non-`{ error }` envelope — a 200 that carries `{ "error": "..." }`
 * is treated as a failure so an outage is never masked as "no data".
 *
 * Note: this asserts the *top-level* response shape only. Per-element
 * contract validation (e.g. zod on `Sample*`) is intentionally left to the
 * view layer / types — adding a schema dependency here would be heavier than
 * the contract drift risk warrants.
 */
async function parseApiResponse<T>(r: Response, url: string): Promise<T> {
  const contentType = r.headers.get("content-type") ?? "";
  const text = await r.text();
  if (!r.ok) {
    const snippet = contentType.includes("application/json") ? redactErrorSnippet(text).slice(0, 200) : "(non-JSON body omitted)";
    const err = new Error(`${r.status} ${r.statusText} on ${url}${snippet ? `: ${snippet}` : ""}`);
    // Attach the status so retry policies (e.g. TQ.retry) can avoid useless
    // retries on terminal 4xx responses.
    (err as { status?: number }).status = r.status;
    throw err;
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`Unexpected content-type "${contentType || "none"}" from ${url}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON body from ${url}`);
  }
 // A 200 response carrying an `{ error }` envelope is still a failure — do NOT
 // coerce it into an empty list (which would mask an outage as "no data").
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    (data as { error?: unknown }).error
  ) {
    throw new Error(`Backend error from ${url}: ${String((data as { error?: unknown }).error)}`);
  }
  return data as T;
}

async function getJson<T>(url: string): Promise<T> {
  // Bound every list fetch with a timeout so a stalled/half-open backend
  // (socket accepted but no response) rejects and surfaces isError / the
  // offline fallback instead of spinning in a permanent loading state. List
  // endpoints are row-capped, so the cap cannot truncate a legitimate response.
  const r = await fetch(url, {
    headers: JSON_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
 // Delegate all validation + parsing to the shared helper so every cockpit
 // read applies the same content-type + error-envelope guards.
  return parseApiResponse<T>(r, url);
}

/**
 * Extract the list payload for a view.
 *
 * When `respKey` is provided, the hook has a deterministic contract: the
 * response MUST be an object carrying an array at `respKey` (e.g.
 * `{ "tabs": [...] }`). If that array is missing or non-array, we throw —
 * this is a contract violation / degraded backend response and must NOT be
 * silently turned into an empty list (which would mask an outage as "no
 * data"). The "first array wins" scan is reserved strictly for endpoints that
 * genuinely have no `respKey`; in that case a non-array-but-valid payload
 * yields `[]` (a legitimately empty dataset), never fabricating data.
 */
function pickList<T>(payload: unknown, respKey?: string): T[] {
  if (respKey) {
    if (!payload || typeof payload !== "object") {
      throw new Error(`Expected object response with key "${respKey}"`);
    }
    const value = (payload as Record<string, unknown>)[respKey];
    if (!Array.isArray(value)) {
      throw new Error(
        `Expected array at "${respKey}" but got ${typeof value} (backend contract drift / outage?)`,
      );
    }
    return value as T[];
  }
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/**
 * Factory that builds a list-fetching TanStack Query hook for a single
 * `/api/cowork/<path>` endpoint.
 *
 * @param key TanStack query key segments after the shared "cowork" root.
 * @param url Relative API URL (e.g. "/api/cowork/tabs").
 * @param respKey Optional named key in the JSON response. When provided, the
 * hook requires `data[respKey]` to be a present array (see `pickList`),
 * entering `isError` rather than showing "no data" on contract drift.
 */
function createQueryHook<T>(key: string[], url: string, respKey?: string) {
  return () => useQuery<T[]>({
    queryKey: ["cowork", ...key],
    queryFn: async () => {
      const data = await getJson<Record<string, unknown>>(url);
      return pickList<T>(data, respKey);
    },
 // Retain the previous list during a background refetch so switching between
 // list views (e.g. tabs → agents) does not flash an empty/loading state.
    placeholderData: (prev: T[] | undefined) => prev,
    ...TQ,
  });
}

// ─── Tabs / Workspaces / Agents / Workflows ────────────────────────────────
export const useTabs = createQueryHook<SampleTab>(["tabs"], "/api/cowork/tabs", "tabs");
export const useWorkspaces = createQueryHook<SampleWorkspace>(["workspaces"], "/api/cowork/workspaces", "workspaces");
export const useAgents = createQueryHook<SampleAgent>(["agents"], "/api/cowork/agents", "agents");
export const useAgentTasks = createQueryHook<SampleTask>(["agents", "tasks"], "/api/cowork/agents/tasks", "tasks");
export const useWorkflows = createQueryHook<SampleWorkflow>(["workflows"], "/api/cowork/workflows", "workflows");

// ─── Security / Sessions / Extensions ──────────────────────────────────────
export const useSecurityEvents = createQueryHook<SampleSecurityEvent>(["security", "events"], "/api/cowork/security/events", "events");
export const useSessions = createQueryHook<SampleSession>(["sessions"], "/api/cowork/sessions", "sessions");
export const useExtensions = createQueryHook<SampleExtension>(["extensions"], "/api/cowork/extensions", "extensions");

// ─── Memory ────────────────────────────────────────────────────────────────
export const useSiteMemory = createQueryHook<SampleSiteMemoryEntry>(["memory", "site"], "/api/cowork/memory/site", "memories");
export const useFormMemory = createQueryHook<SampleFormMemoryEntry>(["memory", "form"], "/api/cowork/memory/form", "memories");

// ─── MCP Tools ─────────────────────────────────────────────────────────────
export const useMcpTools = createQueryHook<SampleMcpTool>(["mcp", "tools"], "/api/cowork/mcp/tools", "tools");

// ─── Bookmarks / History / Pinboards ───────────────────────────────────────
export const useBookmarks = createQueryHook<SampleBookmark>(["bookmarks"], "/api/cowork/bookmarks", "bookmarks");
export const useHistory = createQueryHook<SampleHistoryEntry>(["history"], "/api/cowork/history", "history");
export const usePinboards = createQueryHook<SamplePinboard>(["pinboards"], "/api/cowork/pinboards", "pinboards");

// ─── Logs (extension in-memory ring buffer) ─────────────────────────────────
export interface CoworkLogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  stack: string;
}

export const useLogs = createQueryHook<CoworkLogRecord>(["extensions", "log"], "/api/cowork/extensions/log", "logs");

// ─── Chat ──────────────────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
}

/** Minimal shape returned by the chat proxy. */
interface ChatResponse {
  content?: string;
  error?: string;
}

/**
 * Send a chat message to the Wingman chat proxy.
 *
 * The client POSTs to the same-origin Next.js `/api/cowork/ai/chat` route
 * (which internally forwards to the mini-service on port 3003) — it does NOT
 * address port 3003 directly from the browser. A fresh `sessionId` is minted
 * per request so each chat session gets its own socket.io room.
 */
export function useSendChat() {
  return useMutation({
    mutationFn: async (payload: { text: string; history?: Array<{ role: string; content: string }>; signal?: AbortSignal }) => {
      const messages = [
        ...(payload.history ?? []),
        { role: "user", content: payload.text },
      ];
      const r = await fetch("/api/cowork/ai/chat", {
        method: "POST",
        headers: {
          ...JSON_HEADERS,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages,
 // Generate a unique sessionId per request so each chat session
 // gets its own socket.io room on the mini-service. Previously this
 // was `payload.from ?? "ui"` — which collapsed every dashboard chat
 // session into room "user", so two browser tabs would receive each
 // other's streamed tokens.
 // Unique sessionId per request so each chat session gets its own
 // socket.io room on the mini-service (a shared id would cross-stream tabs).
          sessionId: `ui-${
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          }`,
 // The cockpit does not join the per-session room, so disable streaming and
 // let the mini-service return the assembled text in the final JSON.
          stream: false,
        }),
 // Thread the caller's AbortController signal so chat-view can cancel an
 // in-flight request, combined with a 60s timeout aligned to the route budget.
        signal: payload.signal
          ? AbortSignal.any([AbortSignal.timeout(60000), payload.signal])
          : AbortSignal.timeout(60000),
      });
 // Reuse the shared validator so the chat POST gets the same content-type +
 // `{ error }` envelope guards as the REST list hooks.
      return parseApiResponse<ChatResponse>(r, "/api/cowork/ai/chat");
    },
 // No cache invalidation — chat state is local `useState` in the chat view.
  });
}

/** Convenience invalidator for any view (used by the WS hook). */
export function useInvalidateView() {
  const qc = useQueryClient();
  return useCallback(
    (keys: string[]) => qc.invalidateQueries({ queryKey: ["cowork", ...keys] }),
    [qc],
  );
}
