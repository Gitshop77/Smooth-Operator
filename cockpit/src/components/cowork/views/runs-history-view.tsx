"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  History, ListChecks, Filter, GitBranch, Clock, SearchX, AlertCircle,
} from "lucide-react";

import { useAgentTasks, useHistory } from "@/hooks/use-cowork-query";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable } from "@/components/cowork/shared/data-table";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { SearchInput } from "@/components/cowork/shared/search-input";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { timeAgo, hostnameOf, safeHref, truncateMiddle, safeParseJsonArray } from "@/lib/cowork-data/format";

import type { SampleTask, SampleHistoryEntry } from "@/lib/cowork-data/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

// Terminal task statuses (stable module-level identity so effects/memos that
// reference it don't need it in their dependency arrays).
const TERMINAL = new Set(["done", "failed", "cancelled"]);

type TaskStep = { label?: string; done?: boolean };

function parseSteps(task: SampleTask): TaskStep[] {
  return safeParseJsonArray<TaskStep>((task as { stepsJson?: unknown }).stepsJson);
}

/**
 * Best-effort run duration. The cockpit API exposes NO per-task timing/log
 * field — `completedAt` is the only time signal (see .audit/data.md §2).
 * We derive duration from `createdAt → completedAt` and only when BOTH are
 * present; otherwise we surface "—" rather than fabricate a number.
 */
function computeDuration(task: SampleTask): string {
  const start = +new Date(task.createdAt);
  const end = task.completedAt ? +new Date(task.completedAt) : null;
  if (!Number.isFinite(start) || !end || !Number.isFinite(end) || end < start) {
    return "—";
  }
  const ms = end - start;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Date-range cutoffs in ms for the Runs filter.
const RANGE_MS: Record<string, number | null> = {
  all: null,
  "24h": 24 * 3600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

// ─── View ───────────────────────────────────────────────────────────────────

export function RunsHistoryView() {
  const { data: tasks, isLoading: tasksLoading, isError: tasksError, error: tasksErr } = useAgentTasks();
  const { data: history, isLoading: historyLoading, isError: historyError, error: historyErr } = useHistory();

  const setView = useCoworkStore((s) => s.setView);

  const [tab, setTab] = React.useState<"runs" | "history">("runs");
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [agentFilter, setAgentFilter] = React.useState("all");
  const [dateRange, setDateRange] = React.useState<keyof typeof RANGE_MS>("all");

 // Distinct status + agent values for the Runs filters.
  const statuses = React.useMemo(() => {
    const set = new Set<string>();
    (tasks ?? []).forEach((t) => set.add(t.status));
    return ["all", ...Array.from(set).sort()];
  }, [tasks]);

  const agents = React.useMemo(() => {
    const set = new Set<string>();
    (tasks ?? []).forEach((t) => {
      if (t.agentId) set.add(t.agentId);
    });
    return ["all", ...Array.from(set).sort()];
  }, [tasks]);

  const sortedRuns = React.useMemo(
    () =>
      (tasks ?? []).slice().sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
      ),
    [tasks],
  );

  const filteredRuns = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = RANGE_MS[dateRange];
    // Relative date-range filtering needs the current wall clock; recomputed
    // only when the memo deps change.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    return sortedRuns.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (agentFilter !== "all" && (t.agentId ?? "") !== agentFilter) return false;
      if (cutoff != null) {
        const ts = +new Date(t.createdAt);
        if (!Number.isFinite(ts) || now - ts > cutoff) return false;
      }
      if (q) {
        const hay = `${t.title} ${t.description ?? ""} ${t.agentId ?? ""} ${t.assignedTo ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sortedRuns, statusFilter, agentFilter, dateRange, search]);

  const filteredHistory = React.useMemo(() => {
    const all = (history ?? []).slice().sort(
      (a, b) => +new Date(b.visitedAt) - +new Date(a.visitedAt),
    );
    const q = search.trim().toLowerCase();
    const cutoff = RANGE_MS[dateRange];
    // Relative date-range filtering needs the current wall clock; recomputed
    // only when the memo deps change.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    const searchFiltered = q
      ? all.filter((h) => `${h.title} ${h.url}`.toLowerCase().includes(q))
      : all;
    if (cutoff == null) return searchFiltered;
    return searchFiltered.filter((h) => {
      const ts = +new Date(h.visitedAt);
      return Number.isFinite(ts) && now - ts <= cutoff;
    });
  }, [history, search, dateRange]);

 // Runs summary stats (terminal-aware, like agents-view).
  const totalRuns = tasks?.length ?? 0;
 // Single pass over tasks (memoized) instead of three separate filter().length
 // scans per render — consistent with filteredRuns/agents above.
  const { running, done, failed } = React.useMemo(() => {
    let r = 0, d = 0, f = 0;
    for (const t of tasks ?? []) {
      if (!TERMINAL.has(t.status)) r++;
      else if (t.status === "done") d++;
      else if (t.status === "failed") f++;
    }
    return { running: r, done: d, failed: f };
  }, [tasks]);

  const openRun = (runId: string) => setView("run-detail", { runId });

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Runs & History"
        description="Autonomous agent runs (tasks) and recent browser history."
        eyebrow="Observe"
        icon={<History className="size-5" />}
        actions={
          <SearchInput
            value={search}
            onChange={setSearch}
            ariaLabel="Search runs and history"
            placeholder="Search mission, url, agent…"
            className="w-64"
          />
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "runs" | "history")}>
        <TabsList>
          <TabsTrigger value="runs">
            Runs <span className="ml-1 text-xs text-muted-foreground tnum">({totalRuns})</span>
          </TabsTrigger>
          <TabsTrigger value="history">
            History <span className="ml-1 text-xs text-muted-foreground tnum">({history?.length ?? 0})</span>
          </TabsTrigger>
        </TabsList>

        {/* ─── Runs ─────────────────────────────────────────────────────── */}
        <TabsContent value="runs" className="mt-4 space-y-4">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            <StatCard label="Total runs" value={totalRuns} tone="accent" icon={<ListChecks className="size-4" />} />
            <StatCard label="Active" value={running} tone="info" />
            <StatCard label="Done" value={done} tone="success" />
            <StatCard label="Failed" value={failed} tone="danger" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as keyof typeof RANGE_MS)}>
              <SelectTrigger className="h-8 w-36 text-sm" size="sm" aria-label="Filter by date range">
                <Clock className="size-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="24h">Last 24h</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-40 text-sm" size="sm" aria-label="Filter by status">
                <Filter className="size-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "All statuses" : s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-8 w-48 text-sm" size="sm" aria-label="Filter by agent">
                <GitBranch className="size-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a === "all" ? "All agents" : truncateMiddle(a, 28)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {tasksLoading ? (
            <LoadingSkeleton rows={6} />
          ) : tasksError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load runs"
              description={tasksErr?.message ?? "The runs endpoint returned an error. Check that the backend is reachable and NEXT_PUBLIC_COWORK_UI_TOKEN is configured."}
            />
          ) : filteredRuns.length === 0 ? (
            <EmptyState
              icon={<SearchX className="size-6" />}
              title={search || statusFilter !== "all" || agentFilter !== "all" || dateRange !== "all" ? "No matching runs" : "No runs yet"}
              description="Agent runs appear here once tasks are created by the browser extension."
            />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
              <DataTable
                caption="Agent runs"
                columns={["Mission", "Status", "Duration", "Steps", "Started"]}
              >
                {filteredRuns.map((t) => {
                  const steps = parseSteps(t);
                  let doneSteps = 0;
                  for (const s of steps) if (s.done) doneSteps++;
                  return (
                    <tr
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open run: ${t.title}`}
                      onClick={() => openRun(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openRun(t.id);
                        }
                      }}
                      className="hover:bg-accent/40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <td className="px-4 py-2.5 min-w-[220px]">
                        <p className="text-sm font-medium truncate">{t.title}</p>
                        {t.description ? (
                          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{t.description}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusPill tone={toneForStatus(t.status)} pulse={t.status === "running"}>
                          {t.status}
                        </StatusPill>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                        {computeDuration(t)}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] cowork-mono tnum whitespace-nowrap">
                        {steps.length === 0 ? "—" : `${doneSteps}/${steps.length}`}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                        {timeAgo(t.createdAt)} ago
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </motion.div>
          )}
        </TabsContent>

        {/* ─── History ─────────────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-4 space-y-4">
          {historyLoading ? (
            <LoadingSkeleton rows={6} />
          ) : historyError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load history"
              description={historyErr?.message ?? "The history endpoint returned an error. Check that the backend is reachable and NEXT_PUBLIC_COWORK_UI_TOKEN is configured."}
            />
          ) : filteredHistory.length === 0 ? (
            <EmptyState
              icon={<SearchX className="size-6" />}
              title={search ? "No matching history" : "No browsing history"}
              description="Recent browser history synced from the extension shows up here."
            />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
              <DataTable
                caption="Browsing history"
                columns={["Title", "URL", "Visits", "First visited", "Last visited"]}
              >
                {filteredHistory.map((h: SampleHistoryEntry) => (
                  <tr key={h.id} className="hover:bg-accent/40 transition-colors">
                    <td className="px-4 py-2.5 min-w-[200px]">
                      <p className="text-sm truncate">{h.title}</p>
                    </td>
                    <td className="px-4 py-2.5 max-w-[280px]">
                      <a
                        href={safeHref(h.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] cowork-mono text-primary hover:underline truncate block"
                        onClick={(e) => {
 // Defensive: never navigate to a non-http(s) href.
                          if (safeHref(h.url) === "#") e.preventDefault();
                        }}
                      >
                        {h.url ? hostnameOf(h.url) : "—"}
                      </a>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono tnum whitespace-nowrap">{h.visitCount}</td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                      {timeAgo(h.firstVisitedAt ?? h.visitedAt)} ago
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                      {timeAgo(h.visitedAt)} ago
                    </td>
                  </tr>
                ))}
              </DataTable>
            </motion.div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
