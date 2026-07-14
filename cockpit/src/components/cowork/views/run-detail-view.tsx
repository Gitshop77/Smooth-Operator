"use client";

import * as React from "react";
import {
  ArrowLeft, Download, ImageOff, Activity, Cpu, DollarSign,
  Clock, GitBranch, User, CalendarDays, FileJson, ListChecks,
} from "lucide-react";

import { useAgentTasks } from "@/hooks/use-cowork-query";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { timeAgo, truncateMiddle } from "@/lib/cowork-data/format";

import type { SampleTask } from "@/lib/cowork-data/types";

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type TaskStep = { label?: string; done?: boolean };
type ToolCallLike = {
  type?: string; kind?: string; tool?: string; action?: string;
  reason?: string; message?: string; detail?: string; label?: string;
};

function computeDuration(task: SampleTask): string {
  const start = +new Date(task.createdAt);
  const end = task.completedAt ? +new Date(task.completedAt) : null;
  if (!Number.isFinite(start) || !end || !Number.isFinite(end) || end < start) {
    return "—";
  }
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface RunDetailViewProps {
  /** Inline mode: pass a runId directly (e.g. when embedded by another view). */
  runId?: string;
}

export function RunDetailView({ runId: propRunId }: RunDetailViewProps) {
  const { data: tasks, isLoading } = useAgentTasks();
  const storeRunId = useCoworkStore((s) => s.viewParams?.runId ?? null);
  const setView = useCoworkStore((s) => s.setView);

  const runId = propRunId ?? storeRunId;
  const task = React.useMemo(
    () => (tasks ?? []).find((t) => t.id === runId) ?? null,
    [tasks, runId],
  );

  const stepsJson = task ? (task as { stepsJson?: unknown }).stepsJson : undefined;
  const resultsJson = task ? (task as { resultsJson?: unknown }).resultsJson : undefined;

  const steps = React.useMemo<TaskStep[]>(
    () => (task ? parseJsonArray<TaskStep>(stepsJson) : []),
    [task, stepsJson],
  );

 // Surfaces reasoning/tool-calls if the API ever populates `resultsJson`
 // with structured data. Today this is empty for most runs (.audit/data.md §2).
  const results = React.useMemo(
    () => (task ? parseJsonArray<ToolCallLike>(resultsJson) : []),
    [task, resultsJson],
  );
  const resultsObj = React.useMemo(
    () => (task ? parseJsonObject(resultsJson) : null),
    [task, resultsJson],
  );

  const exportJson = React.useCallback(() => {
    if (!task) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      task: {
        id: task.id,
        agentId: task.agentId,
        tabId: task.tabId,
        title: task.title,
        description: task.description,
        status: task.status,
        currentStep: task.currentStep,
        assignedTo: task.assignedTo,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
      },
      steps: parseJsonArray<TaskStep>(stepsJson),
      results: parseJsonArray<unknown>(resultsJson),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run-${task.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [task, stepsJson, resultsJson]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <ViewHeader
          title="Run detail"
          eyebrow="Observe"
          icon={<Activity className="size-5" />}
        />
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="space-y-4">
        <ViewHeader
          title="Run detail"
          eyebrow="Observe"
          icon={<Activity className="size-5" />}
          actions={
            <Button variant="outline" size="sm" onClick={() => setView("runs-history")}>
              <ArrowLeft className="size-4 mr-1" /> Back to runs
            </Button>
          }
        />
        <EmptyState
          icon={<FileJson className="size-6" />}
          title="No run selected"
          description="Pick a run from the Runs & History list to see its detail."
        />
      </div>
    );
  }

  const doneSteps = steps.filter((s) => s.done).length;
  const pct = steps.length === 0 ? 0 : Math.round((doneSteps / steps.length) * 100);
  const duration = React.useMemo(() => computeDuration(task), [task]);

  const hasStructuredResults =
    results.length > 0 ||
    (resultsObj !== null && Object.keys(resultsObj).length > 0);

  return (
    <div className="space-y-4">
      <ViewHeader
        title={task.title}
        description={task.description ?? "Agent run detail"}
        eyebrow="Observe · Run detail"
        icon={<Activity className="size-5" />}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setView("runs-history")}>
              <ArrowLeft className="size-4 mr-1" /> Back
            </Button>
            <Button variant="default" size="sm" onClick={exportJson}>
              <Download className="size-4 mr-1" /> Export JSON
            </Button>
          </div>
        }
      />

      {/* Identity + lifecycle */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone={toneForStatus(task.status)} pulse={task.status === "running"}>
          {task.status}
        </StatusPill>
        <span className="text-xs text-muted-foreground cowork-mono inline-flex items-center gap-1.5">
          <GitBranch className="size-3.5" /> {task.agentId ? truncateMiddle(task.agentId, 24) : "—"}
        </span>
        <span className="text-xs text-muted-foreground cowork-mono inline-flex items-center gap-1.5">
          <User className="size-3.5" /> {task.assignedTo ?? "unassigned"}
        </span>
        <time
          dateTime={Number.isFinite(+new Date(task.createdAt)) ? new Date(task.createdAt).toISOString() : undefined}
          className="text-xs text-muted-foreground cowork-mono inline-flex items-center gap-1.5"
        >
          <CalendarDays className="size-3.5" /> started {timeAgo(task.createdAt)} ago
        </time>
        {task.createdBy ? (
          <span className="text-xs text-muted-foreground cowork-mono inline-flex items-center gap-1.5">
            by {truncateMiddle(task.createdBy, 20)}
          </span>
        ) : null}
      </div>

      {/* Summary stat cards */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatCard label="Steps" value={`${doneSteps}/${steps.length}`} tone="accent" icon={<ListChecks className="size-4" />} delta={steps.length ? `${pct}% complete` : "no steps"} />
        <StatCard label="Duration" value={duration} icon={<Clock className="size-4" />} />
        {/* Cost is NOT exposed by the cockpit API (.audit/data.md §5). */}
        <StatCard label="Cost" value="—" icon={<DollarSign className="size-4" />} delta="not tracked" />
        {/* Model is NOT stored on the Task model. */}
        <StatCard label="Model" value="—" icon={<Cpu className="size-4" />} delta="not stored" />
      </div>

      {/* Activity timeline — derived from the task's stepsJson checklist. */}
      <Card className="p-4 gap-3">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="size-4 text-muted-foreground" />
          <p className="cowork-eyebrow">Activity timeline</p>
        </div>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No step activity recorded for this run.</p>
        ) : (
          <ol className="relative space-y-3 pl-4 border-l border-border">
            {steps.map((s, i) => (
              <li key={i} className="relative">
                <span
                  className={`absolute -left-[21px] top-1 size-2.5 rounded-full border ${
                    s.done ? "bg-success border-success" : "bg-muted border-border"
                  }`}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className={`text-sm ${s.done ? "text-muted-foreground" : "text-foreground"}`}>
                    {s.label ?? `Step ${i + 1}`}
                  </p>
                  <span className="text-[11px] cowork-mono text-muted-foreground whitespace-nowrap">
                    {s.done ? "done" : "pending"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Screenshots — NO data source in the API (.audit/data.md §6). */}
      <Card className="p-4 gap-3">
        <div className="flex items-center gap-2 mb-1">
          <ImageOff className="size-4 text-muted-foreground" />
          <p className="cowork-eyebrow">Screenshots</p>
        </div>
        <EmptyState
          icon={<ImageOff className="size-6" />}
          title="No screenshots available"
          description="Session screenshots and step recordings are extension-only and are not exposed by the cockpit API."
          className="py-8"
        />
      </Card>

      {/* Reasoning + tool calls — best-effort from resultsJson. */}
      <Card className="p-4 gap-3">
        <div className="flex items-center gap-2 mb-1">
          <FileJson className="size-4 text-muted-foreground" />
          <p className="cowork-eyebrow">Reasoning & tool calls</p>
        </div>
        {!hasStructuredResults ? (
          <EmptyState
            icon={<FileJson className="size-6" />}
            title="No detailed run log"
            description="The cockpit API does not persist per-task reasoning or tool-call logs, so no step-level trace is available for this run."
            className="py-8"
          />
        ) : results.length > 0 ? (
          <ul className="space-y-2">
            {results.map((r, i) => {
              const kind = r.type ?? r.kind ?? r.tool ?? r.action ?? "event";
              const detail = r.reason ?? r.message ?? r.detail ?? r.label ?? "";
              return (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-[11px] cowork-mono text-primary mt-0.5 px-1.5 py-0.5 rounded bg-primary/10 whitespace-nowrap">
                    {kind}
                  </span>
                  <span className="text-foreground/90">{detail}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <pre
            tabIndex={0}
            role="region"
            aria-label="Run log (JSON)"
            className="text-xs cowork-mono text-muted-foreground max-h-64 overflow-auto cowork-scroll rounded-lg border border-border bg-muted/30 p-3"
          >
            {JSON.stringify(resultsObj, null, 2)}
          </pre>
        )}
      </Card>

      {/* Cost breakdown — NO data source in the API (.audit/data.md §5). */}
      <Card className="p-4 gap-3">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign className="size-4 text-muted-foreground" />
          <p className="cowork-eyebrow">Cost breakdown</p>
        </div>
        <EmptyState
          icon={<DollarSign className="size-6" />}
          title="No cost data available"
          description="Token usage and cost accounting are not exposed by the cockpit API. A Cost & Usage view would require a new persisted usage model."
          className="py-8"
        />
      </Card>
    </div>
  );
}
