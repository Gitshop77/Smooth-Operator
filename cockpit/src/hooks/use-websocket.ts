"use client";

import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useInvalidateView } from "@/hooks/use-cowork-query";

// The mini-service requires the shared secret on every socket.io
// connection. The cockpit dashboard is same-origin with the Next.js app, so
// the operator can publish the token to the browser via
// `NEXT_PUBLIC_COWORK_EVENT_TOKEN` (defaults to the dev-mode `dev-token`).
// In production, set BOTH `COWORK_EVENT_TOKEN` (server-side, used by the
// middleware + mini-service) and `NEXT_PUBLIC_COWORK_EVENT_TOKEN` (browser-
// visible, used by this hook) to the same value.
const WS_TOKEN =
  process.env.NEXT_PUBLIC_COWORK_EVENT_TOKEN || "dev-token";

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
      } catch {
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
      const on = (event: string, invalidateKeys: string[][], label: string) => {
        socket?.on(event, (payload: unknown) => {
          setLastEvent(label);
          for (const key of invalidateKeys) {
            invalidate(key);
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
