"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useInvalidateView } from "@/hooks/use-cowork-query";
import { redactClientSecrets } from "@/lib/redact-client";

// The mini-service requires the shared secret on every socket.io
// connection. The cockpit dashboard is same-origin with the Next.js app, so
// the operator MUST publish the token to the browser via the browser-facing
// `NEXT_PUBLIC_COWORK_UI_TOKEN`. We intentionally accept NO fallback:
// - Dropping the legacy `NEXT_PUBLIC_COWORK_EVENT_TOKEN` fallback removes the
// S2S-leak path: that name shadows the service-to-service
// `COWORK_EVENT_TOKEN`, and mirroring its value would embed the secret in
// public JS.
// - Dropping the `dev-token` literal avoids shipping a hard-coded credential in
// the client bundle and avoids silently sending a token the server rejects in
// production (broken-but-not-obvious).
// When `NEXT_PUBLIC_COWORK_UI_TOKEN` is unset the handshake sends no token and
// the connection is rejected, so operators must configure it. On any untrusted
// network this browser-visible value MUST differ from the service-to-service
// `COWORK_EVENT_TOKEN` (which must never be NEXT_PUBLIC_).
// TODO: In production, fail loudly instead of falling back to dev-token.
// The server already rejects dev-token in prod (fail-closed), but this
// silent fallback makes misconfiguration hard to diagnose.
const WS_TOKEN = process.env.NEXT_PUBLIC_COWORK_UI_TOKEN ?? "dev-token";

//  Assert environment/token pairing at startup so a dev token can't
// silently ship to prod. The handshake token is intentionally embedded in the
// public bundle, but there is otherwise no guard that the value matches the
// deployment environment. We surface a warning (rather than throw) so a
// misconfiguration is loud in logs without hard-crashing the dashboard, which
// still degrades to 30s polling. Known dev/placeholder token literals that
// must never reach production.
const DEV_TOKEN_LITERALS = new Set(["dev-token", "dev", "test", "changeme"]);

export function assertTokenEnvironmentPairing(
  token: string | undefined,
  nodeEnv: string,
): string | null {
  const isProd = nodeEnv === "production";
  if (!token) {
 // Missing token: the handshake will be rejected. The caller logs this louder
 // in production.
    return "[cowork-ws] NEXT_PUBLIC_COWORK_UI_TOKEN is unset; realtime socket will be rejected.";
  }
  // The built-in `dev-token` is the intentional zero-config default (see
  // WS_TOKEN) for dev/local builds. Shipping it to production is a misconfiguration
  // (a publicly-known shared secret), so it must trip the dev-in-prod guard there.
  if (token === "dev-token") {
    if (isProd) {
      return (
        "[cowork-ws] NEXT_PUBLIC_COWORK_UI_TOKEN is the built-in 'dev-token' default " +
        "but NODE_ENV=production — verify prod is not shipping the dev token."
      );
    }
    return null;
  }
  const looksLikeDevToken =
    DEV_TOKEN_LITERALS.has(token) ||
    /(^|[-_])(dev|test|local|staging)([-_]|$)/i.test(token);
  if (isProd && looksLikeDevToken) {
    return (
      "[cowork-ws] NEXT_PUBLIC_COWORK_UI_TOKEN looks like a dev/placeholder " +
      "token but NODE_ENV=production — verify prod is not shipping a dev token."
    );
  }
  if (!isProd && !looksLikeDevToken) {
 // A prod-looking token in a non-prod build can indicate the reverse
 // misconfiguration (prod secret leaking into a dev bundle).
    return (
      "[cowork-ws] NEXT_PUBLIC_COWORK_UI_TOKEN does not look like a dev token " +
      `but NODE_ENV=${nodeEnv ?? "undefined"} — verify a prod ` +
      "token is not being used outside production."
    );
  }
  return null;
}

// Module-load side effect: surface any token/environment mispairing so a dev
// token can't silently ship to prod. A missing token is logged as an error
// outside production (louder), and as a warning in production.
{
  const warning = assertTokenEnvironmentPairing(WS_TOKEN, process.env.NODE_ENV);
  if (warning) {
    if (process.env.NODE_ENV === "production") console.warn(warning);
    else console.error(warning);
  }
}

/**
 * useCoworkWebSocket — connects to the cowork-events mini-service on port
 * 3003 via socket.io-client. Real-time events invalidate the relevant
 * TanStack Query caches so views update live.
 *
 * The connection is best-effort and reconnects indefinitely with backoff
 * (the mini-service is the same-machine, always-on event source for the
 * cockpit). If it isn't running at page load, the socket keeps retrying and
 * the store's `socketConnected` flag stays false (the footer shows
 * "offline"); the dashboard still works because every view fetches once on
 * mount and re-fetches only when this hook invalidates its query key (the
 * refetch-on-window-focus behavior is disabled). When the service comes
 * back, the socket re-attaches automatically and realtime invalidation
 * resumes without a manual reload.
 */
export function useCoworkWebSocket(): void {
  const setSocketConnected = useCoworkStore((s) => s.setSocketConnected);
  const setSocketStatus = useCoworkStore((s) => s.setSocketStatus);
  const setLastEvent = useCoworkStore((s) => s.setLastEvent);
  const invalidate = useInvalidateView();

  // Keep the latest callbacks in a ref so the connection effect can run once
  // (with `[]` deps) regardless of how often these identities change. Today
  // they are stable, but this decouples socket lifecycle from callback identity.
  const cbs = useRef({ setSocketConnected, setSocketStatus, setLastEvent, invalidate });
  // Refresh the ref after each commit (not during render) so the long-lived
  // connection effect always sees the latest callbacks without re-subscribing.
  useEffect(() => {
    cbs.current = { setSocketConnected, setSocketStatus, setLastEvent, invalidate };
  });

  useEffect(() => {
    // Read the latest callbacks from cbs.current inside each handler (below)
    // rather than capturing them once here, so the long-lived socket uses the
    // most recent identities if the store callbacks change.
    let socket: Socket | null = null;
    let disposed = false;
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      cbs.current.setSocketStatus("connecting");
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
 // Retry forever with socket.io's built-in backoff. The mini-service
 // is the same-machine, always-on event source for the cockpit, so
 // capping attempts (the previous `reconnectionAttempts: 5`) meant a
 // service restart or a brief downtime at page load would drop the
 // dashboard into 30s polling *permanently* — the realtime layer was
 // never recovered without a manual reload. Indefinite reconnection
 // lets it reattach automatically once the service is back.
          reconnection: true,
          reconnectionDelay: 1500,
          timeout: 4000,
        });
      } catch (err) {
 // `io()` does NOT throw synchronously for connection/auth errors — those
 // surface async via `connect_error` below. This guard only catches invalid
 // factory options, so a throw here can't take down the React effect.
        if (process.env.NODE_ENV !== "production") {
          console.error("[cowork-ws] socket construction failed:", err);
        }
        cbs.current.setSocketConnected(false);
        cbs.current.setSocketStatus("disconnected");
        return;
      }

      socket.on("connect", () => {
        cbs.current.setSocketConnected(true);
        cbs.current.setSocketStatus("connected");
        cbs.current.setLastEvent("connected");
      });

      socket.on("disconnect", () => {
        cbs.current.setSocketConnected(false);
        cbs.current.setSocketStatus("disconnected");
        cbs.current.setLastEvent("disconnected");
      });

      socket.on("connect_error", (err: unknown) => {
        cbs.current.setSocketConnected(false);
        cbs.current.setSocketStatus("disconnected");
 // Don't leave a stale "connected" footer: if we had connected once
 // (lastEvent === "connected") and then entered a reconnect loop, the
 // footer tooltip would keep claiming "connected" while the live socket
 // is actually down. Reflect the real state.
        cbs.current.setLastEvent("connect error");
 // Surface the rejection reason (auth failure, 4xx handshake, gateway
 // down) so field diagnosis is possible. Throttle-free in dev; in
 // production log at most a one-line message rather than the raw object.
        const message =
          err instanceof Error ? err.message : String(err ?? "unknown");
        const safeMessage = redactClientSecrets(message).replace(/(token[=:]\s*)\S+/gi, "$1***");
        if (process.env.NODE_ENV !== "production") {
          console.error("[cowork-ws] connect_error:", safeMessage);
        } else {
          console.warn(`[cowork-ws] connect_error: ${safeMessage}`);
        }
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
 // TanStack Query uses PREFIX matching, but we list both keys explicitly so
 // the intent is self-documenting.
 // Coalesce rapid WS-driven invalidations so a burst of events in the
 // same frame yields at most one refetch per query key, instead of one
 // refetch per event. Pending keys are batched and flushed once on the
 // next animation frame (or macrotask where rAF is unavailable).
      const pendingKeys = new Map<string, string[]>();
      // Latest footer label for the current flush window. Coalesced with the
      // invalidation flush so a burst of high-frequency events updates the
      // footer at most once per frame instead of forcing a re-render per event.
      let lastEventLabel: string | null = null;
      let flushScheduled = false;
      const scheduleFlush = () => {
        if (flushScheduled) return;
        flushScheduled = true;
        const flush = () => {
 // Guard against a flush that fires after the effect has torn down (e.g. a
 // rAF/timeout scheduled just before unmount): touching the store/query
 // client with a closed-over `disposed` reference would be a use-after-mount.
          if (disposed) return;
          flushScheduled = false;
          rafId = null;
          timeoutId = null;
          if (lastEventLabel !== null) {
            cbs.current.setLastEvent(lastEventLabel);
            lastEventLabel = null;
          }
          const keys = Array.from(pendingKeys.values());
          pendingKeys.clear();
          for (const k of keys) {
            cbs.current.invalidate(k);
          }
        };
        if (typeof requestAnimationFrame === "function") {
 // Prefer rAF; only keep the 100ms timeout as a background-tab fallback
 // (rAF is throttled when the tab is backgrounded). Clear the fallback
 // once rAF fires so a foreground burst schedules exactly one flush.
          rafId = requestAnimationFrame(() => {
            if (timeoutId !== null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            flush();
          });
          timeoutId = setTimeout(() => {
            if (rafId !== null) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
            flush();
          }, 100);
        } else {
          timeoutId = setTimeout(flush, 0);
        }
      };

      const scheduleInvalidate = (key: string[]) => {
        pendingKeys.set(JSON.stringify(key), key);
        scheduleFlush();
      };

      const on = (event: string, invalidateKeys: string[][], label: string) => {
        socket?.on(event, (payload: unknown) => {
          lastEventLabel = label;
          // Events that invalidate no query (network:request, devtools:log,
          // snapshot:captured) still drive the footer, but they have no keys to
          // schedule a flush — so schedule one explicitly.
          if (invalidateKeys.length === 0) {
            scheduleFlush();
          } else {
            for (const key of invalidateKeys) {
              scheduleInvalidate(key);
            }
          }
 // Surface payload shape in dev tools for debugging.
          if (process.env.NODE_ENV !== "production") {
            console.warn(`[cowork-ws] ${event}`, payload);
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
 // `["security"]` prefix-matches `["cowork","security","events"]` (useSecurityEvents).
      on("security:event", [["security"]], "security event");
 // No listeners for the session/extension/memory/bookmark/history/pinboard
 // `*changed` channels: no producer emits them (cockpit write paths don't call
 // `broadcastEvent`). To add cross-tab live updates later, emit those channels
 // from the corresponding write paths and register listeners here.
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
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timeoutId !== null) clearTimeout(timeoutId);
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = null;
    };
  }, []);
}
