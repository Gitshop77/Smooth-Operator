"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Bot, Check, AlertCircle, Clock, ListChecks, RotateCcw,
} from "lucide-react";

import { useAgents, useAgentTasks } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { Button } from "@/components/ui/button";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

// Prisma `Task.status` enum: 'pending' | 'running' | 'paused' |
// 'waiting-approval' | 'ready-to-resume' | 'done' | 'failed' | 'cancelled'.
// Count everything that isn't terminal as "pending" for the tab badge.
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function AgentsView() {
  const { data: agents, isLoading: agentsLoading, isError: agentsError, refetch: refetchAgents } = useAgents();
  const { data: tasks, isLoading: tasksLoading, isError: tasksError, refetch: refetchTasks } = useAgentTasks();

  // Memoize so the fallback `[]` keeps a stable identity across renders — this
  // prevents downstream useMemo hooks (keyed on `list`) from recomputing every render.
  const list = React.useMemo(() => tasks ?? [], [tasks]);
  const pending = list.filter((t) => !TERMINAL.has(t.status));
 // `createdAt` arrives as an ISO string (Prisma DateTime serialized over
 // JSON). Coerce to ms before subtracting so the sort is stable regardless
 // of whether the value is a number, ISO string, or Date. Fall back to the
 // id on ties so the order is deterministic across renders.
  const recent = React.useMemo(
    () =>
      list.slice().sort((a, b) => {
        const diff = +new Date(b.createdAt) - +new Date(a.createdAt);
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      }),
    [list],
  );
  const recentWithSteps = React.useMemo(() => {
    return recent.map((t) => {
      const raw = (t as { stepsJson?: unknown }).stepsJson;
      let steps: { label?: string; done?: boolean }[] = [];
      if (Array.isArray(raw)) {
        steps = raw as { label?: string; done?: boolean }[];
      } else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) steps = parsed as { label?: string; done?: boolean }[];
        } catch {
          steps = [];
        }
      }
      const done = steps.filter((s) => s.done).length;
      const pct = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);
      return { t, steps, done, pct };
    });
  }, [recent]);

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Agents"
        description="Autonomous agents and their tasks"
        icon={<Bot className="size-5" />}
      />

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks <span className="ml-1 text-xs text-muted-foreground tnum">({pending.length} active)</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          {agentsLoading ? (
            <LoadingSkeleton variant="cards" cardCount={4} />
          ) : agentsError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load agents"
              description="The agents endpoint returned an error. Try again shortly."
              action={
                <Button size="sm" variant="outline" onClick={() => refetchAgents()}>
                  <RotateCcw className="size-3.5 mr-1" /> Retry
                </Button>
              }
            />
          ) : (agents ?? []).length === 0 ? (
            <EmptyState
              icon={<Bot className="size-6" />}
              title="No agent trust grants"
              description="Agents are registered via the browser extension."
            />
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid gap-4 grid-cols-1 md:grid-cols-2"
            >
              {(agents ?? []).map((a) => (
                <Card key={a.id} className="p-5 gap-3">
                  <div className="flex items-start gap-3">
                    <div className="size-10 rounded-full bg-muted text-muted-foreground grid place-items-center shrink-0 capitalize">
                      {(a.name || "Unnamed").slice(0, 1)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold truncate">{a.name || "Unnamed"}</p>
                        <StatusPill tone={toneForStatus(a.status)}>
                          {a.status}
                        </StatusPill>
                      </div>
                      <p className="text-xs text-muted-foreground">{a.type}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end text-xs text-muted-foreground">
                    <span>active {timeAgo(a.lastActive)} ago</span>
                  </div>
                </Card>
              ))}
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          {tasksLoading ? (
            <LoadingSkeleton rows={5} />
          ) : tasksError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load tasks"
              description="The tasks endpoint returned an error. Try again shortly."
              action={
                <Button size="sm" variant="outline" onClick={() => refetchTasks()}>
                  <RotateCcw className="size-3.5 mr-1" /> Retry
                </Button>
              }
            />
          ) : recent.length === 0 ? (
            <EmptyState
              icon={<ListChecks className="size-6" />}
              title="No tasks"
              description="Tasks are created by agents running in the browser extension."
            />
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3"
            >
              {recentWithSteps.map(({ t, steps, done, pct }) => {
                return (
                  <Card key={t.id} className="p-4 gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {/* Task `title` is the required primary
                              identifier (Prisma `Task.title: String`).
                              `description` is nullable (`String?`) and is
                              rendered as subtext below. */}
                          <p className="font-medium truncate">{t.title}</p>
                          <StatusPill tone={toneForStatus(t.status)} pulse={t.status === "running"}>
                            {t.status}
                          </StatusPill>
                        </div>
                        {t.description ? (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {t.description}
                          </p>
                        ) : null}
                        <p className="text-xs text-muted-foreground mt-1">
                          Assigned to <span className="text-foreground">{t.assignedTo ?? "—"}</span> · created by{" "}
                          <span className="text-foreground">{t.createdBy ?? "—"}</span> · {timeAgo(t.createdAt)} ago
                        </p>
                      </div>
                      {t.status === "failed" ? (
                        <AlertCircle className="size-5 text-danger shrink-0" />
                      ) : t.status === "done" ? (
                        <Check className="size-5 text-success shrink-0" />
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <ListChecks className="size-3.5" />
                          <span className="tnum">{done}/{steps.length}</span> steps
                        </span>
                        <span className="tnum">{pct}%</span>
                      </div>
                      <Progress
                        value={pct}
                        className="h-1.5"
                        aria-label={`Progress for ${t.title}: ${pct}% (${done} of ${steps.length} steps)`}
                      />
                      <ol className="text-xs space-y-1 mt-2">
                        {steps.map((s, i) => (
                          <li key={i} className="flex items-center gap-2">
                            {s.done ? (
                              <Check className="size-3 text-success" />
                            ) : (
                              <Clock className="size-3 text-muted-foreground" />
                            )}
                            <span className={s.done ? "text-muted-foreground line-through" : ""}>
                              {s.label}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </Card>
                );
              })}
            </motion.div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
