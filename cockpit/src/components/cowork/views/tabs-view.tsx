"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  RefreshCw, Pin, VolumeX, Loader2, AlertCircle,
  Search, AppWindow,
} from "lucide-react";

import { useTabs } from "@/hooks/use-cowork-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { DataTable } from "@/components/cowork/shared/data-table";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { timeAgo, hostnameOf, truncateMiddle, safeHref } from "@/lib/cowork-data/format";

export function TabsView() {
  const { data, isLoading, refetch, isFetching } = useTabs();
  const [filter, setFilter] = React.useState("");

  const tabs = React.useMemo(() => {
    const all = data ?? [];
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter(
      (t) =>
        t.title?.toLowerCase().includes(q) ||
        t.url?.toLowerCase().includes(q) ||
        t.workspaceName?.toLowerCase().includes(q),
    );
  }, [data, filter]);

  /* Summary metrics */
  const total = data?.length ?? 0;
  const loading = (data ?? []).filter((t) => t.status === "loading").length;
  const workspaces = new Set((data ?? []).map((t) => t.workspaceName).filter(Boolean)).size;

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Tabs"
        description="Persisted browser tabs across all workspaces"
        eyebrow="Browsing"
        icon={<AppWindow className="size-5" />}
        actions={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tabs…"
                className="pl-8 h-8 w-44 sm:w-52 text-sm"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-8"
            >
              <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </>
        }
      />

      {/* Summary metric cards */}
      <div className="grid gap-3 grid-cols-3">
        <Card className="p-3 gap-0.5">
          <p className="cowork-eyebrow">Total</p>
          <p className="text-xl font-semibold tnum">{total}</p>
        </Card>
        <Card className="p-3 gap-0.5">
          <p className="cowork-eyebrow">Workspaces</p>
          <p className="text-xl font-semibold tnum">{workspaces}</p>
        </Card>
        <Card className="p-3 gap-0.5">
          <p className="cowork-eyebrow">Loading</p>
          <p className="text-xl font-semibold tnum text-chart-1">{loading}</p>
        </Card>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : tabs.length === 0 ? (
        <EmptyState
          icon={<AppWindow className="size-5" />}
          title="No Tabs Found"
          description="No tabs match your filter. Tabs are persisted by the cockpit API — open the browser extension to populate."
          action={
            filter ? (
              <Button size="sm" variant="outline" onClick={() => setFilter("")}>
                Clear Filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <DataTable
            columns={[
              "Tab",
              "Workspace",
              "Status",
              "Last Accessed",
            ]}
          >
            {tabs.map((tab) => (
              <tr
                key={tab.id}
                className="hover:bg-accent/50 transition-colors border-l-[3px] border-transparent hover:border-primary"
              >
                <td className="px-4 py-2.5 min-w-[200px]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="size-6 rounded border border-primary/20 bg-primary/5 text-primary grid place-items-center shrink-0 text-[10px] cowork-mono font-semibold">
                      {hostnameOf(tab.url).slice(0, 1).toUpperCase() || "?"}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-sm truncate max-w-[260px]">
                          {tab.title || "(Untitled)"}
                        </span>
                        {tab.pinned ? <Pin className="size-3 text-muted-foreground shrink-0" /> : null}
                        {tab.audiblyMuted ? <VolumeX className="size-3 text-muted-foreground shrink-0" /> : null}
                      </div>
                      <a
                        href={safeHref(tab.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] cowork-mono text-muted-foreground hover:text-primary hover:underline truncate block max-w-[320px]"
                        title={tab.url}
                      >
                        {truncateMiddle(tab.url, 64)}
                      </a>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm">{tab.workspaceName ?? "—"}</span>
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={toneForStatus(tab.status)} pulse={tab.status === "loading"}>
                    {tab.status === "loading" ? <Loader2 className="size-3 animate-spin" /> : null}
                    {tab.status === "crashed" ? <AlertCircle className="size-3" /> : null}
                    {tab.status}
                  </StatusPill>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground tnum cowork-mono text-[11px]">
                  {timeAgo(tab.lastAccessed)} ago
                </td>
              </tr>
            ))}
          </DataTable>
        </motion.div>
      )}

      <Card className="p-3 text-[11px] text-muted-foreground cowork-mono">
        Showing <span className="tnum font-medium text-foreground">{tabs.length}</span> of{" "}
        <span className="tnum font-medium text-foreground">{total}</span> tabs.
        Live updates arrive over WebSocket on port&nbsp;3003.
      </Card>
    </div>
  );
}
