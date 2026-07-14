"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  ListChecks,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { ConnectionStatus } from "@/components/layout/connection-status";
import { timeAgo } from "@/lib/cowork-data/format";
import {
  useAgents,
  useAgentTasks,
  useSecurityEvents,
  useSessions,
  useTabs,
} from "@/hooks/use-cowork-query";
import type {
  SampleAgent,
  SampleSecurityEvent,
  SampleSession,
  SampleTab,
  SampleTask,
} from "@/lib/cowork-data/types";

/** Tone union used by `StatusPill`. */
type PillTone = ReturnType<typeof toneForStatus>;

/** Parse a Prisma timestamp (number | string | Date) into epoch ms. */
function toTime(ts: number | string | Date | null | undefined): number {
  if (ts == null) return NaN;
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

const DAY_MS = 86_400_000;

/** Map a security severity to a StatusPill tone (critical/high → error). */
function toneForSeverity(sev: string): PillTone {
  switch (sev.toLowerCase()) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
    case "info":
    default:
      return "info";
  }
}

/** Numeric weight for ordering errors by severity (highest first). */
function severityWeight(sev: string): number {
  switch (sev.toLowerCase()) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

/** Count tasks per day over the last `days` days (oldest → newest). */
function lastNDaysBuckets(tasks: SampleTask[], days: number, now: number): number[] {
  const buckets = new Array<number>(days).fill(0);
  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  for (const t of tasks) {
    const ms = toTime(t.createdAt);
    if (!Number.isFinite(ms)) continue;
    const dayIdx = Math.floor((ms - startOfToday) / DAY_MS);
 // dayIdx is 0 for today, -1 for yesterday, -2 for two days ago, etc.
    const bucketPos = days - 1 + dayIdx; // today is the last bucket
    if (bucketPos >= 0 && bucketPos < days) buckets[bucketPos] += 1;
  }
  return buckets;
}

/**
 * Tiny inline SVG sparkline. Stroke inherits `currentColor`, so callers drive
 * the color via a token text class (e.g. `text-accent`). No animation, so it is
 * inherently safe under `prefers-reduced-motion`.
 */
function Sparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const w = 76;
  const h = 22;
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={cn("overflow-visible", className)}
      fill="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Overview — the cockpit home / debug dashboard.
 *
 * All metrics are composed client-side from existing list endpoints (there is
 * no dedicated KPI route). Cost/spend has no backing data source in the
 * current API layer, so those cards render "—" gracefully. See `.audit/data.md`
 * (§1 Overview KPIs / §5 Cost & Usage) for the availability matrix.
 */
/** Renders a relative time with an absolute, machine-readable `dateTime`. */
function RelativeTime({
  ts,
  className,
}: {
  ts: number | string | Date | null | undefined;
  className?: string;
}) {
  const iso = toTime(ts);
  return (
    <time
      dateTime={Number.isFinite(iso) ? new Date(iso).toISOString() : undefined}
      className={className}
    >
      {timeAgo(ts)}
    </time>
  );
}

export function OverviewView() {
  const agents = useAgents();
  const tasks = useAgentTasks();
  const events = useSecurityEvents();
  const sessions = useSessions();
  const tabs = useTabs();

  const agentsList = React.useMemo<SampleAgent[]>(
    () => agents.data ?? [],
    [agents.data],
  );
  const tasksList = React.useMemo<SampleTask[]>(
    () => tasks.data ?? [],
    [tasks.data],
  );
  const eventsList = React.useMemo<SampleSecurityEvent[]>(
    () => events.data ?? [],
    [events.data],
  );
  const sessionsList = React.useMemo<SampleSession[]>(
    () => sessions.data ?? [],
    [sessions.data],
  );
  const tabsList = React.useMemo<SampleTab[]>(() => tabs.data ?? [], [tabs.data]);

  const now = React.useMemo(() => Date.now(), []);

 // ─── KPI derivations ────────────────────────────────────────────────────
  const runs7d = React.useMemo(
    () => tasksList.filter((t) => now - toTime(t.createdAt) <= 7 * DAY_MS),
    [tasksList, now],
  );
  const runsToday = React.useMemo(
    () => runs7d.filter((t) => now - toTime(t.createdAt) <= DAY_MS),
    [runs7d, now],
  );

  const runs7dBuckets = React.useMemo(
    () => lastNDaysBuckets(tasksList, 7, now),
    [tasksList, now],
  );

  const successRate = React.useMemo(() => {
    const total = tasksList.length;
    if (total === 0) return null;
    const done = tasksList.filter(
      (t) => t.status.toLowerCase() === "done",
    ).length;
    return Math.round((done / total) * 100);
  }, [tasksList]);

  const openErrors = React.useMemo(
    () =>
      eventsList.filter((e) => {
        const sev = e.severity.toLowerCase();
        return (sev === "critical" || sev === "high") && !e.falsePositive;
      }),
    [eventsList],
  );

 // ─── Recent lists ───────────────────────────────────────────────────────
  const recentRuns = React.useMemo(
    () =>
      [...tasksList]
        .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
        .slice(0, 6),
    [tasksList],
  );

  const recentErrors = React.useMemo(
    () =>
      [...eventsList]
        .sort((a, b) => {
          const w = severityWeight(b.severity) - severityWeight(a.severity);
          if (w !== 0) return w;
          return toTime(b.createdAt) - toTime(a.createdAt);
        })
        .slice(0, 6),
    [eventsList],
  );

  const dash = "—";

  return (
    <div className="space-y-6">
      <ViewHeader
        title="Overview"
        description="Debug and analyze your agents"
        eyebrow="Observe"
        icon={<Activity className="size-4" />}
      />

      {/* Live status strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <ConnectionStatus />
        <span className="inline-flex items-center gap-1.5">
          <Bot className="size-3.5" aria-hidden="true" />
          <span className="cowork-mono tnum">{agentsList.length}</span>
          <span>agents</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ListChecks className="size-3.5" aria-hidden="true" />
          <span className="cowork-mono tnum">{tasksList.length}</span>
          <span>runs</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Activity className="size-3.5" aria-hidden="true" />
          <span className="cowork-mono tnum">{sessionsList.length}</span>
          <span>sessions</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          <span className="cowork-mono tnum">{tabsList.length}</span>
          <span>tabs</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          <span className="cowork-mono tnum">{openErrors.length}</span>
          <span>open errors</span>
        </span>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard
          label="Active agents"
          value={agents.isLoading ? dash : agentsList.length}
          tone="accent"
          icon={<Bot className="size-4" />}
        />
        <StatCard
          label="Runs today"
          value={tasks.isLoading ? dash : runsToday.length}
          tone="info"
          icon={<ListChecks className="size-4" />}
        />
        <StatCard
          label="Runs 7d"
          value={tasks.isLoading ? dash : runs7d.length}
          tone="info"
          icon={<CalendarDays className="size-4" />}
          delta={
            <span className="inline-flex items-center gap-1.5">
              <Sparkline values={runs7dBuckets} className="text-accent" />
              <span>daily</span>
            </span>
          }
        />
        <StatCard
          label="Success rate"
          value={successRate == null ? dash : `${successRate}%`}
          delta={
            successRate == null ? undefined : `${tasksList.length} total runs`
          }
          tone={successRate == null ? "default" : "success"}
          icon={<CheckCircle2 className="size-4" />}
        />
        <StatCard
          label="Spend 7d"
          value={dash}
          delta="no usage API"
          tone="default"
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label="Spend 30d"
          value={dash}
          delta="no usage API"
          tone="default"
          icon={<DollarSign className="size-4" />}
        />
        <StatCard
          label="Open errors"
          value={events.isLoading ? dash : openErrors.length}
          tone={openErrors.length > 0 ? "danger" : "success"}
          icon={<AlertTriangle className="size-4" />}
        />
      </div>

      {/* Recent runs + recent errors */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4 gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent runs</h2>
            <span className="text-xs text-muted-foreground cowork-mono tnum">
              {tasksList.length}
            </span>
          </div>
          {recentRuns.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Agent tasks will appear here as they are created."
            />
          ) : (
            <ul className="divide-y divide-border">
              {recentRuns.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm truncate" title={t.title}>
                      {t.title || "Untitled run"}
                    </p>
                    <RelativeTime ts={t.createdAt} className="text-xs text-dim cowork-mono" />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className="text-xs text-dim cowork-mono tnum"
                      title="Cost data unavailable"
                    >
                      {dash}
                    </span>
                    <StatusPill tone={toneForStatus(t.status)}>
                      {t.status}
                    </StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4 gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent errors</h2>
            <span className="text-xs text-muted-foreground cowork-mono tnum">
              {eventsList.length}
            </span>
          </div>
          {recentErrors.length === 0 ? (
            <EmptyState
              title="No security events"
              description="Flagged injections, blocks, and incidents will appear here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {recentErrors.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm truncate" title={e.description}>
                      {e.description || e.type}
                    </p>
                    <p className="text-xs text-dim cowork-mono">
                      {e.type} · <RelativeTime ts={e.timestamp} />
                    </p>
                  </div>
                  <StatusPill tone={toneForSeverity(e.severity)}>
                    {e.severity}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export default OverviewView;
