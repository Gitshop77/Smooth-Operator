"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Boxes, Cookie, EyeOff, PlayCircle, Smartphone } from "lucide-react";

import { useSessions } from "@/hooks/use-cowork-query";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

/**
 * Sessions — list view.
 *
 * Data source: `GET /api/cowork/sessions` via `useSessions()` (resp key
 * `sessions`). The persisted `SampleSession` shape carries `name`, `partition`,
 * `userAgent`, `createdAt`, `isIncognito` / `isDefault`, and a hardcoded
 * `cookieCount` — there is **no** `status`, `agent`, or `duration` column on
 * the model, so those cannot be rendered without a schema/API change. We show
 * the only meaningful status (incognito / default) as a `StatusPill` and the
 * session's "started" time from `createdAt`.
 *
 * Clicking a session deep-links into the replay via
 * `setView("session-replay", { sessionId })`.
 */
export function SessionsView() {
  const { data, isLoading } = useSessions();
  const setView = useCoworkStore((s) => s.setView);
  const reduceMotion = useReducedMotion();

  const sessions = data ?? [];

  return (
    <div className="space-y-4">
      <ViewHeader
        eyebrow="Observe"
        title="Sessions"
        description="Isolated browser sessions with their own cookies and storage. Open one to replay the agent's run."
        icon={<Boxes className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={4} />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Boxes className="size-6" />}
          title="No sessions"
          description="Sessions are created via POST /api/cowork/sessions. The cockpit dashboard is currently read-only."
        />
      ) : (
        <motion.div
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 md:grid-cols-2"
        >
          {sessions.map((s) => {
            const activate = () => setView("session-replay", { sessionId: s.id });
            return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={activate}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }}
              aria-label={`Replay session ${s.name}`}
              className="group text-left rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold truncate">{s.name}</p>
                    {s.isIncognito ? (
                      <StatusPill tone="warning">
                        <EyeOff className="size-3" /> incognito
                      </StatusPill>
                    ) : s.isDefault ? (
                      <StatusPill tone="info">default</StatusPill>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
                    {s.partition}
                  </p>
                </div>
                <span
                  className="shrink-0 grid size-8 place-items-center rounded-lg bg-primary/10 text-primary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                  aria-hidden
                >
                  <PlayCircle className="size-5" />
                </span>
              </div>

              <div className="space-y-2 pt-3 mt-3 border-t border-border text-xs">
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Smartphone className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{s.userAgent}</span>
                </p>
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Cookie className="size-3.5 shrink-0" />
                  <span>
                    <span className="tnum text-foreground font-medium">
                      {s.cookieCount}
                    </span>{" "}
                    cookies
                  </span>
                  <span className="ml-auto">
                    started <span className="tnum">{timeAgo(s.createdAt)}</span> ago
                  </span>
                </p>
              </div>
            </div>
          );})}
        </motion.div>
      )}
    </div>
  );
}
