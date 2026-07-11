"use client";

import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useInvalidateView } from "@/hooks/use-cowork-query";

// The mini-service requires the shared secret on every socket.io
// connection. The cockpit dashboard is same-origin with the Next.js app, so
// the operator MUST publish the token to the browser via the browser-facing
// `NEXT_PUBLIC_COWORK_UI_TOKEN`. We intentionally accept NO fallback:
//  - Dropping the legacy `NEXT_PUBLIC_COWORK_EVENT_TOKEN` fallback removes the
//    S2S-leak path: that name shadows the service-to-service
//    `COWORK_EVENT_TOKEN`, and mirroring its value would embed the secret in
//    public JS.
//  - Dropping the `dev-token` literal avoids shipping a hard-coded credential in
//    the client bundle and avoids silently sending a token the server rejects in
//    production (broken-but-not-obvious).
// When `NEXT_PUBLIC_COWORK_UI_TOKEN` is unset the handshake sends no token and
// the connection is rejected, so operators must configure it. On any untrusted
// network this browser-visible value MUST differ from the service-to-service
// `COWORK_EVENT_TOKEN` (which must never be NEXT_PUBLIC_).
const WS_TOKEN = process.env.NEXT_PUBLIC_COWORK_UI_TOKEN;

/**
 * useCoworkWebSocket — connects to the cowork-events mini-service on port
 * 3003 via socket.io-client. Real-time events invalidate the relevant
 * TanStack Query caches so views update live.
 *
 * The connection is best-effort: if the mini-service isn't running, the
 * socket silently fails to connect and the store's `socketConnected` flag
 * stays false (the footer shows "offline"). The dashboard still works
 * because every view polls its endpoint on mount + every 30s via TanStack
 * Query.
 */
export function useCoworkWebSocket(): void {
  const setSocketConnected = useCoworkStore((s) => s.setSocketConnected);
  const setLastEvent = useCoworkStore((s) => s.setLastEvent);
  const invalidate = useInvalidateView();

  useEffect(() => {
    let socket: Socket | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      try {
        socket = io({
          // The mini-service's socket.io is attached with path '/'.
          // The gateway forwards based on the XTransformPort query param.
          path: "/",
          query: { XTransformPort: "3003" },
          // send the shared secret on the handshake so the
          // mini-service doesn't reject the connection.
          auth: { token: WS_TOKEN },
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1500,
          timeout: 4000,
        });
      } catch (err) {
        // Don't swallow the real cause of a failed socket construction — log it
        // (non-production only) so a misconfiguration (e.g. missing
        // NEXT_PUBLIC_COWORK_UI_TOKEN, bad gateway) is diagnosable instead of a
        // silent "offline" footer.
        if (process.env.NODE_ENV !== "production") {
          console.error("[cowork-ws] socket connection failed:", err);
        }
        setSocketConnected(false);
        return;
      }

      socket.on("connect", () => {
        setSocketConnected(true);
        setLastEvent("connected");
      });

      socket.on("disconnect", () => {
        setSocketConnected(false);
        setLastEvent("disconnected");
      });

      socket.on("connect_error", () => {
        setSocketConnected(false);
      });

      // Real-time event handlers (the mini-service emits these).
      //
      // The `on` helper accepts an ARRAY of key-segment arrays
      // (`string[][]`). Each inner array is one query key to invalidate
      // (joined with the `cowork` prefix by `useInvalidateView`). This lets
      // a single WS event invalidate multiple distinct query keys — e.g.
      // `memory:changed` invalidates BOTH `["cowork","memory","site"]`
      // (useSiteMemory) AND `["cowork","memory","form"]` (useFormMemory),
      // and `agent:task-updated` invalidates BOTH `["cowork","agents"]`
      // (useAgents) AND `["cowork","agents","tasks"]` (useAgentTasks).
      //
      // TanStack Query uses PREFIX matching, so a shorter key like
      // `["agents"]` would technically subsume `["agents","tasks"]`, but
      // we list both explicitly so the intent is self-documenting and
      // robust against future changes to TanStack's matching semantics.
      // Coalesce rapid WS-driven invalidations so a burst of events in the
      // same frame yields at most one refetch per query key, instead of one
      // refetch per event. Pending keys are batched and flushed once on the
      // next animation frame (or macrotask where rAF is unavailable).
      const pendingKeys = new Set<string>();
      let flushScheduled = false;
      const scheduleInvalidate = (key: string[]) => {
        pendingKeys.add(JSON.stringify(key));
        if (flushScheduled) return;
        flushScheduled = true;
        const flush = () => {
          flushScheduled = false;
          const keys = Array.from(pendingKeys);
          pendingKeys.clear();
          for (const raw of keys) {
            try {
              invalidate(JSON.parse(raw) as string[]);
            } catch {
              /* ignore malformed key */
            }
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(flush);
        } else {
          setTimeout(flush, 0);
        }
      };

      const on = (event: string, invalidateKeys: string[][], label: string) => {
        socket?.on(event, (payload: unknown) => {
          setLastEvent(label);
          for (const key of invalidateKeys) {
            scheduleInvalidate(key);
          }
          // Surface payload shape in dev tools for debugging.
          if (process.env.NODE_ENV !== "production") {
            console.debug(`[cowork-ws] ${event}`, payload);
          }
        });
      };

      on("tab:updated", [["tabs"]], "tab updated");
      on("tab:closed", [["tabs"]], "tab closed");
      on("tab:opened", [["tabs"]], "tab opened");
      on("workspace:updated", [["workspaces"]], "workspace updated");
      // Invalidate `useAgents` (query key `["cowork","agents"]`) on task
      // updates alongside `useAgentTasks` (`["cowork","agents","tasks"]`).
      on("agent:task-updated", [["agents"], ["agents", "tasks"]], "task updated");
      on("agent:handoff", [["agents"]], "agent handoff");
      // `network:request`, `devtools:log`, and `snapshot:captured` invalidate
      // no query today — the network/devtools/snapshots views are
      // extension-only empty states with no `useQuery`. We still listen so
      // `setLastEvent` (footer tooltip) reflects the activity; the empty key
      // array is a no-op invalidation and forward-wires the hook names for
      // when those views gain data.
      on("network:request", [], "network request");
      on("devtools:log", [], "console log");
      // `["security"]` prefix-matches `["cowork","security","events"]`
      // (useSecurityEvents). The old `["events"]` entry was dead —
      // `["cowork","events"]` matches no query (security uses the
      // `security,events` key, not bare `events`).
      on("security:event", [["security"]], "security event");
      on("session:changed", [["sessions"]], "session changed");
      on("extension:changed", [["extensions"]], "extension changed");
      // Invalidate `useFormMemory` (query key `["cowork","memory","form"]`)
      // alongside `useSiteMemory` (`["cowork","memory","site"]`) on memory
      // changes.
      on("memory:changed", [["memory", "site"], ["memory", "form"]], "memory changed");
      on("bookmark:changed", [["bookmarks"]], "bookmark changed");
      on("history:changed", [["history"]], "history changed");
      on("pinboard:changed", [["pinboards"]], "pinboard changed");
      // The `chat:message` event is emitted by the cowork-events `/chat`
      // route to the per-`sessionId` socket.io room ONLY (never broadcast
      // globally), so the dashboard's socket — which does not join any chat
      // session room — never receives this event. The chat view holds its
      // message list in local `useState`, not in the TanStack cache, so no
      // invalidation is wired up here.
      on("snapshot:captured", [], "snapshot captured");
    };

    connect();

    return () => {
      disposed = true;
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = null;
    };
  }, [setSocketConnected, setLastEvent, invalidate]);
}
