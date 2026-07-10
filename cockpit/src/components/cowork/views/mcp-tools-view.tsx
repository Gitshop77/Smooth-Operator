"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Wrench, Search, ChevronRight } from "lucide-react";

import { useMcpTools } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";

export function McpToolsView() {
  const { data, isLoading } = useMcpTools();
  const [filter, setFilter] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [selected, setSelected] = React.useState<string | null>(null);

  const categories = React.useMemo(() => {
    const set = new Set<string>();
    (data ?? []).forEach((t) => set.add(t.category));
    return ["all", ...Array.from(set).sort()];
  }, [data]);

  const filtered = React.useMemo(() => {
    const all = data ?? [];
    return all.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [data, filter, category]);

  const selectedTool = filtered.find((t) => t.name === selected) ?? filtered[0];

  return (
    <div className="space-y-4">
      <ViewHeader
        title="MCP Tools"
        description="Registry of Model Context Protocol tools"
        icon={<Wrench className="size-5" />}
        actions={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search tools…"
                className="pl-8 h-9 w-44 sm:w-56"
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-9 w-40" size="sm">
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

          {selectedTool ? (
            <Card className="p-5 gap-3 lg:sticky lg:top-20 self-start">
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
          ) : null}
        </motion.div>
      )}
    </div>
  );
}
