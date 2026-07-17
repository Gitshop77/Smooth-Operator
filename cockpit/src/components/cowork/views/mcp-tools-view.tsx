"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Wrench, ChevronRight, AlertCircle, RotateCcw } from "lucide-react";

import { useMcpTools } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/cowork/shared/search-input";

export function McpToolsView() {
  const { data, isLoading, isError, refetch } = useMcpTools();
  const [filter, setFilter] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [selected, setSelected] = React.useState<string | null>(null);

  const categories = React.useMemo(() => {
    const set = new Set<string>();
    (data ?? []).forEach((t) => set.add(t.category));
    return ["all", ...Array.from(set).sort()];
  }, [data]);

  const lowerHaystack = React.useMemo(
    () => (data ?? []).map((t) => `${t.name ?? ""} ${t.description ?? ""}`.toLowerCase()),
    [data],
  );

  const filtered = React.useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter((t, i) => {
      if (category !== "all" && t.category !== category) return false;
      if (!q) return true;
      return (lowerHaystack[i] ?? "").includes(q);
    });
  }, [data, filter, category, lowerHaystack]);

  const selectedTool =
    (selected ? (data ?? []).find((t) => t.name === selected) : undefined) ?? filtered[0];

  return (
    <div className="space-y-4">
      <ViewHeader
        title="MCP Tools"
        description="Registry of Model Context Protocol tools"
        icon={<Wrench className="size-5" />}
        actions={
          <>
            <SearchInput
              value={filter}
              onChange={setFilter}
              ariaLabel="Search tools"
              placeholder="Search tools…"
              className="w-44 sm:w-56"
            />
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-9 w-40" size="sm" aria-label="Filter by category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>{c === "all" ? "All categories" : c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      <Card className="p-3 gap-1 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Showing <span className="tnum text-foreground font-medium">{filtered.length}</span> of{" "}
          <span className="tnum text-foreground font-medium">{data?.length ?? 0}</span> registered tools.
        </p>
      </Card>

      {isLoading ? (
        <LoadingSkeleton rows={8} />
      ) : isError ? (
        <EmptyState
          icon={<AlertCircle className="size-6" />}
          title="Couldn't load tools"
          description="The MCP tools endpoint returned an error. Try again shortly."
          action={
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RotateCcw className="size-3.5 mr-1" /> Retry
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Wrench className="size-6" />} title="No tools match" description="Try a different search or category." />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 lg:grid-cols-[1fr_360px]"
        >
          <Card className="p-0 gap-0 overflow-hidden">
            <div className="max-h-[70vh] overflow-auto cowork-scroll divide-y">
              {filtered.map((t) => {
                const active = selectedTool?.name === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() => setSelected(t.name)}
                    aria-current={active ? "true" : undefined}
                    className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors ${active ? "bg-accent" : "hover:bg-accent/50"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{t.name}</span>
                        <Badge variant="outline" className="text-[10px] font-mono">{t.category}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.description}</p>
                    </div>
                    <ChevronRight className={`size-4 text-muted-foreground shrink-0 transition-transform ${active ? "rotate-90" : ""}`} />
                  </button>
                );
              })}
            </div>
          </Card>

          <Card
            role="region"
            aria-label="Tool details"
            aria-live="polite"
            className="p-5 gap-3 lg:sticky lg:top-20 self-start"
          >
            <div>
              <Badge variant="secondary" className="text-[10px] font-mono mb-2">{selectedTool.category}</Badge>
              <p className="font-mono font-semibold text-base break-all">{selectedTool.name}</p>
              <p className="text-sm text-muted-foreground mt-1.5">{selectedTool.description}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Access</p>
              <p className="text-xs font-mono">{selectedTool.readOnly ? "read-only" : "read-write"}</p>
            </div>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
