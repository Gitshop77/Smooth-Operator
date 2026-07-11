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
  retry: 1,
} as const;

/**
 * The X-Cowork-Token sent on every cockpit REST fetch. It is taken ONLY from
 * the browser-facing `NEXT_PUBLIC_COWORK_UI_TOKEN`. We accept no fallback:
 *  - Dropping the legacy `NEXT_PUBLIC_COWORK_EVENT_TOKEN` fallback removes the
 *    S2S-leak path: that name shadows the service-to-service
 *    `COWORK_EVENT_TOKEN`, and mirroring its value would embed the secret in
 *    public JS.
 *  - Dropping the `dev-token` literal avoids shipping a hard-coded credential in
 *    the client bundle and avoids silently sending a token the server rejects in
 *    production (broken-but-not-obvious).
 * This MUST match the server-side `COWORK_UI_TOKEN` resolved by middleware.ts.
 * The `NEXT_PUBLIC_` prefix exposes this to the browser, so it must NEVER equal
 * the service-to-service `COWORK_EVENT_TOKEN` on any untrusted network.
 */
const COWORK_TOKEN = process.env.NEXT_PUBLIC_COWORK_UI_TOKEN;

// Fail loud on the single most common misconfiguration: a missing UI token
// makes every fetch send an `undefined` header (which throws a raw
// `TypeError` in the browser and a `"undefined"` string string in Node/SSR) —
// surfacing as an opaque failure. Warn clearly at module load so the operator
// knows to set `NEXT_PUBLIC_COWORK_UI_TOKEN`.
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

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: JSON_HEADERS });
  // Read the body once so we can both validate it and surface a useful message.
  const contentType = r.headers.get("content-type") ?? "";
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${r.status} on ${url}${text ? `: ${text.slice(0, 200)}` : ""}`);
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
    throw new Error(`Backend error from ${url}: ${(data as { error?: unknown }).error}`);
  }
  return data as T;
}

/**
 * Extract the first non-empty array among the API payload values. Returns
 * `[]` if nothing useful is found — never returns fabricated data.
 */
function pickList<T>(payload: unknown): T[] {
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
 * `/api/cowork/<path>` endpoint. Collapses ~14 near-identical hand-written
 * hooks (each 8 lines) into one-liners below.
 *
 * @param key      TanStack query key segments after the shared "cowork" root.
 * @param url      Relative API URL (e.g. "/api/cowork/tabs").
 * @param respKey  Optional named key in the JSON response (e.g. "tabs"). When
 *                 provided, the hook prefers `data[respKey] ?? data` so a
 *                 route returning `{ tabs: [...] }` is decoded deterministically
 *                 (instead of relying on `pickList`'s "first array wins"
 *                 scan, which can pick the wrong field if a route ever adds a
 *                 second array).
 */
function createQueryHook<T>(key: string[], url: string, respKey?: string) {
  return () => useQuery<T[]>({
    queryKey: ["cowork", ...key],
    queryFn: async () => {
      const data = await getJson<Record<string, unknown>>(url);
      return pickList<T>(respKey ? data[respKey] ?? data : data);
    },
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

// ─── Chat ──────────────────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
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
          "content-type": "application/json",
          ...(COWORK_TOKEN ? { "X-Cowork-Token": COWORK_TOKEN } : {}),
        },
        body: JSON.stringify({
          messages,
          // Generate a unique sessionId per request so each chat session
          // gets its own socket.io room on the mini-service. Previously this
          // was `payload.from ?? "ui"` — which collapsed every dashboard chat
          // session into room "user", so two browser tabs would receive each
          // other's streamed tokens.
          sessionId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }),
        // Thread the AbortController signal through so the caller (chat-view)
        // can cancel an in-flight chat request — e.g. when the user clicks Clear
        // while the LLM is still streaming. If the signal aborts, `fetch` rejects
        // with an AbortError and TanStack Query surfaces it via `onError`.
        signal: payload.signal,
      });
      if (!r.ok) throw new Error(`chat ${r.status}`);
      return r.json();
    },
    // No cache invalidation here — chat state is local `useState` in the chat
    // view, not a TanStack Query. If a future chat-history query is added, it
    // should use a distinct key like `["cowork", "chat", "history"]` and
    // invalidate it explicitly.
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
