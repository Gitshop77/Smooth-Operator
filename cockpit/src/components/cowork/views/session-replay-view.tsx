"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, Camera, CheckCircle2, ChevronLeft, ChevronRight,
  Circle, Clock, ImageOff, PlayCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useSessions, useAgentTasks } from "@/hooks/use-cowork-query";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { timeAgo } from "@/lib/cowork-data/format";

/**
 * Session Replay — scrubable timeline reconstructing what the agent did.
 *
 * IMPORTANT DATA LIMITATION (see `.audit/data.md` §6): the cockpit API does
 * **not** persist browser screenshots or per-interaction step recordings.
 * Snapshots / DevTools / Network are extension-only and never written to the
 * DB. The only step-level data available is `SampleTask.stepsJson` — an agent
 * *task* checklist (`{ label, done }`), not browser interaction steps. So this
 * view builds a real, useful step-by-step replay from the persisted task
 * steps: each step gets a status (done / active / pending) and the active step
 * is derived from the task's `currentStep` index. A clearly-labeled placeholder
 * explains that screenshot replay is not yet available.
 */

interface ReplayStep {
  key: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  label: string;
  done: boolean;
  active: boolean;
  createdAt: number | string | Date;
}

/** Task statuses that imply work is still in flight (so a step can be "active"). */
const ACTIVE_STATUSES = new Set([
  "running", "paused", "waiting-approval", "ready-to-resume",
]);

export function SessionReplayView() {
  const sessionId = useCoworkStore((s) => s.viewParams?.sessionId ?? null);
  const setView = useCoworkStore((s) => s.setView);

  const sessions = useSessions();
  const tasks = useAgentTasks();

  const session = React.useMemo(
    () =>
      sessionId
        ? (sessions.data ?? []).find((x) => x.id === sessionId)
        : undefined,
    [sessionId, sessions.data],
  );

 // Flatten every task's stepsJson into one ordered, scrubable timeline.
 //
 // DATA LIMITATION: the persisted `SampleTask` model has NO session linkage
 // (no `sessionId` field; tasks reference only `agentId`/`tabId`, and
 // `SampleSession` exposes no task relation). We therefore cannot scope this
 // timeline to `sessionId` — the same global task-step list is shown for every
 // session, and the UI states this explicitly below. `sessionId` is kept in
 // the dependency list so this memo re-evaluates if a real linkage is added.
  const steps = React.useMemo<ReplayStep[]>(() => {
    void sessionId; // no persisted field to filter tasks by session (see above)
    const out: ReplayStep[] = [];
    for (const t of tasks.data ?? []) {
      let parsed: Array<{ label?: string; done?: boolean }> = [];
      try {
        const raw = JSON.parse(t.stepsJson || "[]");
 // JSON.parse of `{}` / `5` / `null` succeeds but is not an array —
 // guard so a non-array value can't crash the render with a TypeError.
        parsed = Array.isArray(raw) ? raw : [];
      } catch {
        parsed = [];
      }
      parsed.forEach((step, i) => {
        const isActive =
          ACTIVE_STATUSES.has(t.status) && i === (t.currentStep ?? 0) && !step.done;
        out.push({
          key: `${t.id}:${i}`,
          taskId: t.id,
          taskTitle: t.title,
          taskStatus: t.status,
          label: step.label ?? `Step ${i + 1}`,
          done: !!step.done,
          active: isActive,
          createdAt: t.createdAt,
        });
      });
    }
    return out;
  }, [tasks.data, sessionId]);

  const [activeIndex, setActiveIndex] = React.useState(0);

 // Default the scrubber to the first not-yet-done step (the live frontier).
  React.useEffect(() => {
    if (steps.length === 0) return;
    const firstUndone = steps.findIndex((s) => !s.done);
    setActiveIndex(firstUndone >= 0 ? firstUndone : steps.length - 1);
  }, [steps]);

  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const idx = Math.min(activeIndex, Math.max(0, total - 1));
  const current = steps[idx];
  const loading = sessions.isLoading || tasks.isLoading;

  const goTo = (next: number) =>
    setActiveIndex(Math.max(0, Math.min(total - 1, next)));

  return (
    <div className="space-y-5">
      <ViewHeader
        eyebrow="Observe / Sessions"
        title={session ? session.name : "Session replay"}
        description={
          session
            ? `${session.partition} · ${session.userAgent ?? "unknown agent"} — note: task steps are shown across all sessions (no session linkage is persisted)`
            : "Reconstructing the agent's run from persisted task steps."
        }
        icon={<PlayCircle className="size-5" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setView("sessions")}
            className="gap-1.5"
          >
            <ArrowLeft className="size-4" /> Sessions
          </Button>
        }
      />

      {loading ? (
        <LoadingSkeleton variant="cards" cardCount={3} />
      ) : sessionId && !session ? (
        <EmptyState
          icon={<PlayCircle className="size-6" />}
          title="Session not found"
          description="This session no longer exists or was never persisted. Return to the sessions list to pick another."
          action={
            <Button variant="outline" size="sm" onClick={() => setView("sessions")}>
              Back to Sessions
            </Button>
          }
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<Clock className="size-6" />}
          title="No replayable steps"
          description="No persisted agent task steps were found. The cockpit stores task checklist steps only — browser screenshots and interaction steps are not yet captured."
        />
      ) : current ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-5"
        >
          {/* Screenshot placeholder — capture is extension-only, not persisted. */}
          <Card className="border-dashed border-border bg-muted/30 p-5">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Camera className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  Screenshot replay not available
                </p>
                <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
                  Visual step screenshots require the extension&apos;s snapshot
                  capture, which is not yet persisted to the cockpit. This replay
                  reconstructs the agent&apos;s actions from the persisted task
                  checklist steps instead.
                </p>
              </div>
            </div>
            <div
              className="mt-4 grid grid-cols-4 sm:grid-cols-6 gap-2"
              aria-hidden
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-video rounded-lg border border-border bg-card grid place-items-center text-muted-foreground/50"
                >
                  <ImageOff className="size-5" />
                </div>
              ))}
            </div>
          </Card>

          {/* Progress + scrubber */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <StatusPill tone={toneForStatus(current.taskStatus)}>
                  {current.taskStatus}
                </StatusPill>
                <span className="text-sm text-muted-foreground truncate max-w-xs">
                  {current.taskTitle}
                </span>
              </div>
              <span className="text-sm tnum text-muted-foreground whitespace-nowrap">
                {doneCount} / {total} steps · {pct}%
              </span>
            </div>

            <Progress value={pct} />

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => goTo(idx - 1)}
                disabled={idx <= 0}
                aria-label="Previous step"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <input
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={idx}
                onChange={(e) => goTo(Number(e.target.value))}
                className="flex-1 accent-primary"
                aria-label="Scrub replay timeline"
                aria-valuetext={`Step ${idx + 1} of ${total}: ${current.label}`}
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => goTo(idx + 1)}
                disabled={idx >= total - 1}
                aria-label="Next step"
              >
                <ChevronRight className="size-4" />
              </Button>
              <span className="text-sm tnum text-muted-foreground whitespace-nowrap w-16 text-right">
                {idx + 1}/{total}
              </span>
            </div>
          </Card>

          {/* Step list */}
          <Card className="p-2 sm:p-3">
            <ol className="space-y-1.5">
              {steps.map((s, i) => {
                const isActive = i === idx;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => setActiveIndex(i)}
                      aria-current={isActive ? "step" : undefined}
                      className={cn(
                        "w-full text-left rounded-xl border px-4 py-3 flex items-start gap-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        isActive
                          ? "border-primary bg-primary/5"
                          : "border-transparent hover:bg-accent",
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {s.done ? (
                          <CheckCircle2 className="size-4 text-success" />
                        ) : s.active ? (
                          <span className="relative flex size-4 items-center justify-center">
                            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-60 cowork-pulse" />
                            <span className="relative inline-flex size-2 rounded-full bg-primary" />
                          </span>
                        ) : (
                          <Circle className="size-4 text-muted-foreground" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {s.label}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <StatusPill tone={toneForStatus(s.taskStatus)}>
                            {s.taskTitle}
                          </StatusPill>
                          <span className="text-xs text-muted-foreground tnum inline-flex items-center gap-1">
                            <Clock className="size-3" /> started {timeAgo(s.createdAt)}
                          </span>
                        </div>
                      </div>
                      {isActive ? (
                        <PlayCircle className="size-4 text-primary shrink-0 mt-0.5" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>

          <p className="text-xs text-muted-foreground">
            Per-step timestamps are not persisted — the times shown are task-level
            (created). The active step is derived from each task&apos;s{" "}
            <code className="font-mono">currentStep</code> index. The timeline
            below aggregates all persisted task steps because the data model does
            not link tasks to a specific session.
          </p>
        </motion.div>
      ) : null}
    </div>
  );
}
