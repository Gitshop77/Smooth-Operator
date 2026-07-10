"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Database, Search, FormInput } from "lucide-react";

import { useSiteMemory, useFormMemory } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { timeAgo } from "@/lib/cowork-data/format";
import type { SampleSiteMemoryEntry } from "@/lib/cowork-data/types";

// Prisma `SiteMemory` has `domain` + `dataJson` (JSON-encoded `SiteData`).
// There are no `key`/`value` columns. The filter matches against `domain`
// AND the raw `dataJson` string so users can search both.
function siteMatches(e: SampleSiteMemoryEntry, q: string): boolean {
  if (e.domain?.toLowerCase().includes(q)) return true;
  const data = e.dataJson;
  if (typeof data === "string" && data.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Parse `dataJson` defensively. Returns the parsed object on success,
 * or `null` on parse failure / empty string. Never throws.
 *
 * The Prisma `SiteMemory.dataJson` column holds a JSON-encoded `SiteData`
 * object (visits[], diffs[], stats). We parse the JSON and render a short
 * summary.
 */
function parseSiteData(e: SampleSiteMemoryEntry): {
  visitCount: number;
  diffCount: number;
  preview: string;
} {
  const empty = { visitCount: 0, diffCount: 0, preview: "" };
  if (typeof e.dataJson !== "string" || e.dataJson.length === 0) return empty;
  try {
    const parsed = JSON.parse(e.dataJson) as Record<string, unknown>;
    const visits = Array.isArray(parsed.visits) ? parsed.visits.length : 0;
    const diffs = Array.isArray(parsed.diffs) ? parsed.diffs.length : 0;
    // Build a short preview from the JSON itself (capped at 120 chars).
    const preview = e.dataJson.length > 120
      ? e.dataJson.slice(0, 120) + "…"
      : e.dataJson;
    return { visitCount: visits, diffCount: diffs, preview };
  } catch {
    return { ...empty, preview: e.dataJson.slice(0, 120) };
  }
}

/**
 * Parse `formDataJson` defensively into a list of `{ field, value }`
 * entries. The Prisma `FormMemory.formDataJson` column holds a JSON-encoded
 * `DomainFormData` object — we look for an `entries` array and fall back to
 * flattening top-level keys. Never throws.
 */
function parseFormEntries(
  e: { formDataJson: string },
): Array<{ field: string; value: string }> {
  if (typeof e.formDataJson !== "string" || e.formDataJson.length === 0) return [];
  try {
    const parsed = JSON.parse(e.formDataJson) as Record<string, unknown>;
    // Preferred shape: { entries: [{ field, value }] }
    if (Array.isArray(parsed.entries)) {
      return parsed.entries
        .filter((x): x is { field: string; value: string } =>
          x != null && typeof x === "object" &&
          "field" in x && "value" in x &&
          typeof (x as { field: unknown }).field === "string" &&
          typeof (x as { value: unknown }).value === "string")
        .map((x) => ({ field: x.field, value: x.value }));
    }
    // Fallback: flatten top-level string keys.
    return Object.entries(parsed)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => ({ field: k, value: String(v) }));
  } catch {
    return [];
  }
}

export function MemoryView() {
  const { data: site, isLoading: siteLoading } = useSiteMemory();
  const { data: form, isLoading: formLoading } = useFormMemory();
  const [filter, setFilter] = React.useState("");

  const siteByDomain = React.useMemo(() => {
    const map = new Map<string, SampleSiteMemoryEntry[]>();
    const q = filter.trim().toLowerCase();
    for (const e of site ?? []) {
      if (q && !siteMatches(e, q)) continue;
      const list = map.get(e.domain);
      if (list) {
        list.push(e);
      } else {
        map.set(e.domain, [e]);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [site, filter]);

  // Flatten form memory into rows of { domain, field, value, updatedAt }
  // by parsing each row's `formDataJson`.
  const formFlattened = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows: Array<{
      domain: string;
      field: string;
      value: string;
      updatedAt: number | string | Date;
    }> = [];
    for (const e of form ?? []) {
      if (q && !formMatches(e, q)) continue;
      // Fall back to 0 (rendered as "—" by `timeAgo`) instead of
      // `Date.now()` — `Date.now()` is impure and triggers React's
      // "impure function during render" lint warning inside `useMemo`.
      const ts = e.updatedAt ?? e.createdAt ?? 0;
      const entries = parseFormEntries(e);
      if (entries.length === 0) {
        // No parsed entries — show a single row with the raw JSON so the
        // user sees that *something* is stored for this domain.
        rows.push({
          domain: e.domain,
          field: "(raw)",
          value: e.formDataJson.slice(0, 80) || "(empty)",
          updatedAt: ts,
        });
      } else {
        for (const entry of entries) {
          rows.push({
            domain: e.domain,
            field: entry.field,
            value: entry.value,
            updatedAt: ts,
          });
        }
      }
    }
    return rows;
  }, [form, filter]);

  // Prisma `FormMemory` has `domain` + `formDataJson` — no `field`/`value`/
  // `formUrl` columns. The filter matches against `domain` AND the raw
  // `formDataJson` string.
  function formMatches(e: { domain: string; formDataJson: string }, q: string): boolean {
    if (e.domain?.toLowerCase().includes(q)) return true;
    if (typeof e.formDataJson === "string" && e.formDataJson.toLowerCase().includes(q)) return true;
    return false;
  }

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Memory"
        description="Per-domain structured memory the browser remembers"
        icon={<Database className="size-5" />}
        actions={
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="pl-8 h-9 w-44 sm:w-56"
            />
          </div>
        }
      />

      <Tabs defaultValue="site">
        <TabsList>
          <TabsTrigger value="site">
            <Database className="size-3.5 mr-1.5" /> Site memory
          </TabsTrigger>
          <TabsTrigger value="form">
            <FormInput className="size-3.5 mr-1.5" /> Form memory
          </TabsTrigger>
        </TabsList>

        <TabsContent value="site" className="mt-4">
          {siteLoading ? (
            <LoadingSkeleton variant="cards" cardCount={4} />
          ) : siteByDomain.length === 0 ? (
            <EmptyState icon={<Database className="size-6" />} title="No site memory" description="Browse a site to start storing structured memory." />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {siteByDomain.map(([domain, entries]) => (
                <Card key={domain} className="p-4 gap-2">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-sm font-semibold">{domain}</p>
                    <span className="text-xs text-muted-foreground"><span className="tnum">{entries.length}</span> snapshots</span>
                  </div>
                  <div className="divide-y divide-border/60">
                    {entries.map((e, i) => {
                      const summary = parseSiteData(e);
                      return (
                        <div key={i} className="flex items-start gap-3 py-2 text-sm">
                          <span className="font-mono text-xs text-muted-foreground shrink-0 w-32 truncate" title={`v${e.version}`}>
                            v{e.version} · {summary.visitCount} visits · {summary.diffCount} diffs
                          </span>
                          <span className="flex-1 break-words font-mono text-xs text-muted-foreground">
                            {summary.preview || "(empty)"}
                          </span>
                          <span className="text-xs text-muted-foreground tnum shrink-0 hidden sm:inline">{timeAgo(e.capturedAt ?? e.updatedAt)} ago</span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="form" className="mt-4">
          {formLoading ? (
            <LoadingSkeleton rows={6} />
          ) : formFlattened.length === 0 ? (
            <EmptyState icon={<FormInput className="size-6" />} title="No form memory" description="Submit a form on any site to remember its values." />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Card className="p-0 gap-0 overflow-hidden">
                <div className="divide-y">
                  {formFlattened.map((e, i) => (
                    <div key={i} className="grid grid-cols-1 sm:grid-cols-4 gap-2 px-4 py-2.5 text-sm hover:bg-accent/40">
                      <span className="font-mono text-xs truncate">{e.domain}</span>
                      <span className="font-mono text-xs text-muted-foreground truncate">{e.field}</span>
                      <span className="font-mono text-xs truncate">{e.value}</span>
                      <span className="text-xs text-muted-foreground tnum sm:text-right">{timeAgo(e.updatedAt)} ago</span>
                    </div>
                  ))}
                </div>
              </Card>
            </motion.div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
