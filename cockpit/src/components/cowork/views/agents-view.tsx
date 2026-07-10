"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Bot, Check, AlertCircle, Clock, ListChecks,
} from "lucide-react";

import { useAgents, useAgentTasks } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

export function AgentsView() {
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const { data: tasks, isLoading: tasksLoading } = useAgentTasks();

  // Prisma `Task.status` enum: 'pending' | 'running' | 'paused' |
  // 'waiting-approval' | 'ready-to-resume' | 'done' | 'failed' | 'cancelled'.
  // Count everything that isn't terminal as "pending" for the tab badge.
  const TERMINAL = new Set(["done", "failed", "cancelled"]);
  const pending = (tasks ?? []).filter((t) => !TERMINAL.has(t.status));
  // `createdAt` arrives as an ISO string (Prisma DateTime serialized over
  // JSON). Coerce to ms before subtracting so the sort is stable regardless
  // of whether the value is a number, ISO string, or Date.
  const recent = (tasks ?? []).slice().sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

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
            Tasks <span className="ml-1 text-xs text-muted-foreground tnum">({pending.length})</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          {agentsLoading ? (
            <LoadingSkeleton variant="cards" cardCount={4} />
          ) : (agents ?? []).length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No agent trust grants. Agents are registered via the browser extension.
            </Card>
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
          ) : recent.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No tasks. Tasks are created by agents running in the browser extension.
            </Card>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3"
            >
              {recent.map((t) => {
                // `stepsJson` is a JSON-encoded string from Prisma (NOT an
                // array). Parse defensively (default to [] on parse error)
                // so a malformed row never crashes the whole view. Each step
                // is `{ label: string; done: boolean }`.
                const steps = (() => {
                  const raw = (t as { stepsJson?: unknown }).stepsJson;
                  if (Array.isArray(raw)) return raw as { label?: string; done?: boolean }[];
                  if (typeof raw !== "string") return [];
                  try {
                    const parsed = JSON.parse(raw);
                    return Array.isArray(parsed)
                      ? (parsed as { label?: string; done?: boolean }[])
                      : [];
                  } catch {
                    return [];
                  }
                })();
                const done = steps.filter((s) => s.done).length;
                const pct = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);
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
                        <AlertCircle className="size-5 text-rose-500 shrink-0" />
                      ) : t.status === "done" ? (
                        <Check className="size-5 text-emerald-500 shrink-0" />
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
                      <Progress value={pct} className="h-1.5" />
                      <ol className="text-xs space-y-1 mt-2">
                        {steps.map((s, i) => (
                          <li key={i} className="flex items-center gap-2">
                            {s.done ? (
                              <Check className="size-3 text-emerald-500" />
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
