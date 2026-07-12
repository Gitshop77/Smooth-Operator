"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, Bug, RotateCcw, Filter, ShieldAlert,
  ChevronRight, Inbox,
} from "lucide-react";

import { useSecurityEvents } from "@/hooks/use-cowork-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/cowork/shared/data-table";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { SearchInput } from "@/components/cowork/shared/search-input";
import { timeAgo } from "@/lib/cowork-data/format";

import type { SampleSecurityEvent } from "@/lib/cowork-data/types";

/**
 * Errors & Incidents view.
 *
 * Data source: `GET /api/cowork/security/events` (resp key `events`), fetched
 * through the `useSecurityEvents` hook in `@/hooks/use-cowork-query`. This is
 * the only available error/incident feed in the cockpit API (see `.audit/
 * data.md` §4). The endpoint accepts a server-side `?severity=` param; the
 * current `useSecurityEvents` hook does not forward query params, so the
 * severity filter below is applied client-side over the fetched set. The
 * "challenge-detected" signal is NOT yet wired into this API (the extension's
 * `antibot.ts` is not connected), so we surface the events we DO have and label
 * the gap explicitly rather than fabricating challenge rows.
 */

// Severity → StatusPill tone. Mirrors the Security view mapping.
const SEVERITY_TONE: Record<string, "error" | "warning" | "info"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "info",
 // Prisma also allows `info`; render it distinctly from `low`.
  info: "info",
};

// Rank used only for sorting / "top severity" aggregation (higher = worse).
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const SEVERITIES = ["all", "critical", "high", "medium", "low", "info"] as const;

// The extension emits antibot/"challenge" incidents as a `SecurityEvent` only
// once wired — until then this type never appears in the payload.
const CHALLENGE_TYPE = "challenge-detected";

interface EventGroup {
  type: string;
  count: number;
  topSeverity: string;
}

/** Build a readable trace/context block from the event's available fields. */
function buildTrace(e: SampleSecurityEvent): string {
  const lines = [
    `type:        ${e.type}`,
    `severity:    ${e.severity}`,
    `blocked:     ${e.blocked}`,
    `confidence:  ${e.confidence ?? "n/a"}`,
    `falsePositive: ${e.falsePositive ?? "n/a"}`,
    `domain:      ${e.domain ?? "n/a"}`,
    `sourceUrl:   ${e.sourceUrl ?? "n/a"}`,
    `tabId:       ${e.tabId ?? "n/a"}`,
    `createdAt:   ${String(e.timestamp)}`,
  ];
  const detail = e.details ?? e.description;
  return [...lines, "", "details:", detail || "(no details provided)"].join("\n");
}

export function ErrorsView() {
  const { data, isLoading, isError } = useSecurityEvents();
  const { toast } = useToast();

  const [search, setSearch] = React.useState("");
  const [severityFilter, setSeverityFilter] = React.useState<string>("all");
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const events = React.useMemo(() => data ?? [], [data]);

  const typeOptions = React.useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => set.add(e.type));
    return ["all", ...Array.from(set).sort()];
  }, [events]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return events
      .filter((e) => {
        if (severityFilter !== "all" && e.severity !== severityFilter) return false;
        if (typeFilter !== "all" && e.type !== typeFilter) return false;
        if (q) {
          const hay = [
            e.type,
            e.description ?? "",
            e.details ?? "",
            e.domain ?? "",
            e.sourceUrl ?? "",
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .slice()
      .sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
  }, [events, severityFilter, typeFilter, search]);

 // Aggregate by type with frequency + worst severity in each group.
  const groups = React.useMemo<EventGroup[]>(() => {
    const map = new Map<string, EventGroup>();
    for (const e of filtered) {
      const g = map.get(e.type) ?? { type: e.type, count: 0, topSeverity: "info" };
      g.count += 1;
      if ((SEVERITY_RANK[e.severity] ?? 0) > (SEVERITY_RANK[g.topSeverity] ?? 0)) {
        g.topSeverity = e.severity;
      }
      map.set(e.type, g);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [filtered]);

 // "challenge-detected" detection (will be empty until the extension wires it).
  const challengeEvents = React.useMemo(
    () => events.filter((e) => e.type === CHALLENGE_TYPE),
    [events],
  );
  const challengeWired = challengeEvents.length > 0;

 // Summary stats (over the filtered set).
  const criticalCount = filtered.filter((e) => e.severity === "critical").length;
  const blockedCount = filtered.filter((e) => e.blocked).length;
  const distinctTypes = groups.length;

  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRetry = React.useCallback(
    (e: SampleSecurityEvent) => {
 // Functional stub — there is no run-recovery endpoint in the cockpit API
 // (see `.audit/data.md` §4/§6). We surface the action via a toast so the
 // UX is complete and wired for when recovery is added.
      toast({
        title: "Retry queued",
        description: `Retry requested for the ${e.type} incident${
          e.domain ? ` on ${e.domain}` : ""
        }. (Stub — no run-recovery endpoint is wired yet.)`,
      });
    },
    [toast],
  );

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Errors & Incidents"
        description="Aggregated security incidents and failure signals"
        eyebrow="Observe"
        icon={<AlertTriangle className="size-5" />}
        actions={
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="h-8 w-40 text-sm" size="sm" aria-label="Filter by severity">
              <Filter className="size-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "All severities" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* Controls: search + type filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search incidents, domains, URLs…"
          ariaLabel="Search errors and incidents"
          className="sm:max-w-xs"
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-9 w-48 text-sm" aria-label="Filter by type">
            <Filter className="size-3 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {t === "all" ? "All types" : t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatCard label="Incidents" value={filtered.length} tone="accent" icon={<Bug className="size-4" />} />
        <StatCard label="Critical" value={criticalCount} tone="danger" />
        <StatCard label="Blocked" value={blockedCount} tone="danger" icon={<ShieldAlert className="size-4" />} />
        <StatCard label="Distinct types" value={distinctTypes} tone="info" />
      </div>

      {/* Challenge-detected section: only when the type is actually wired. */}
      {challengeWired ? (
        <section className="space-y-2">
          <h2 className="cowork-eyebrow">Challenge detected</h2>
          <DataTable caption="Challenge detected incidents" columns={["Severity", "Domain", "When", "Retry"]}>
            {challengeEvents.map((e) => (
              <tr key={e.id} className="hover:bg-accent/40 transition-colors align-top">
                <td className="px-4 py-2.5">
                  <StatusPill tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{e.severity}</StatusPill>
                </td>
                <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground">{e.domain}</td>
                <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                  {timeAgo(e.timestamp)} ago
                </td>
                <td className="px-4 py-2.5">
                  <Button size="sm" variant="outline" onClick={() => handleRetry(e)}>
                    <RotateCcw className="size-3.5 mr-1" /> Retry
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-dashed border-border bg-muted/30 p-4">
          <ShieldAlert className="size-5 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              No &ldquo;challenge detected&rdquo; incidents wired yet
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The extension&rsquo;s antibot logic ({" "}
              <span className="cowork-mono">src/extension/background/antibot.ts</span>) is
              not yet connected to this API, so{" "}
              <span className="cowork-mono">challenge-detected</span> events do not appear
              here. The incidents below are the security signals the API{" "}
              <span className="italic">does</span> surface. They will show up in the
              section above automatically once the extension emits them.
            </p>
          </div>
        </div>
      )}

      {/* Aggregation by type */}
      <section className="space-y-2">
        <h2 className="cowork-eyebrow">By type</h2>
        {groups.length === 0 && !isLoading ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title="No incidents match"
            description="Adjust the search or filters to see aggregated errors by type."
          />
        ) : (
          <DataTable caption="Incidents grouped by type" columns={["Type", "Count", "Top severity"]}>
            {groups.map((g) => (
              <tr key={g.type} className="hover:bg-accent/40 transition-colors">
                <td className="px-4 py-2.5">
                  <span className="text-[11px] cowork-mono">{g.type}</span>
                </td>
                <td className="px-4 py-2.5 tnum text-sm font-medium">{g.count}</td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={SEVERITY_TONE[g.topSeverity] ?? "neutral"}>{g.topSeverity}</StatusPill>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      {/* Incidents detail table */}
      <section className="space-y-2">
        <h2 className="cowork-eyebrow">Incidents</h2>
        {isLoading ? (
          <LoadingSkeleton rows={6} />
        ) : isError ? (
          <EmptyState
            icon={<AlertTriangle className="size-5" />}
            title="Couldn&rsquo;t load incidents"
            description="The security events endpoint returned an error. Try again shortly."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="size-5" />}
            title={events.length === 0 ? "No incidents" : "No matches"}
            description={
              events.length === 0
                ? "No security incidents have been recorded yet."
                : "No incidents match the current search and filters."
            }
          />
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
            <DataTable
              caption="Security incidents"
              columns={["Severity", "Type", "Summary", "When", "Details", "Retry"]}
            >
              {filtered.map((e) => {
                const isOpen = expanded.has(e.id);
                return (
                  <React.Fragment key={e.id}>
                    <tr className="hover:bg-accent/40 transition-colors align-top">
                      <td className="px-4 py-2.5">
                        <StatusPill tone={SEVERITY_TONE[e.severity] ?? "neutral"}>{e.severity}</StatusPill>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-[11px] cowork-mono">{e.type}</span>
                      </td>
                      <td className="px-4 py-2.5 min-w-[240px]">
                        <p className="text-sm leading-snug">{e.description || e.details || "—"}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                        {timeAgo(e.timestamp)} ago
                      </td>
                      <td className="px-4 py-2.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide stack trace" : "Show stack trace"}
                          onClick={() => toggleExpand(e.id)}
                        >
                          <ChevronRight
                            className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          Trace
                        </Button>
                      </td>
                      <td className="px-4 py-2.5">
                        <Button size="sm" variant="outline" onClick={() => handleRetry(e)}>
                          <RotateCcw className="size-3.5 mr-1" /> Retry
                        </Button>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="bg-muted/30">
                        <td colSpan={6} className="px-4 py-3">
                          <pre className="cowork-mono text-xs text-muted-foreground overflow-auto cowork-scroll rounded-lg bg-muted/40 p-3 whitespace-pre">
                            {buildTrace(e)}
                          </pre>
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            Affected runs: <span className="cowork-mono">not linked</span> — the
                            SecurityEvent API exposes no run/task identifier, so incident→run
                            mapping is unavailable.
                          </p>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </DataTable>
          </motion.div>
        )}
      </section>
    </div>
  );
}
