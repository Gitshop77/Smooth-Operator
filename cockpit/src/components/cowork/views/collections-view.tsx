"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Bookmark, History, Pin, Search, ExternalLink } from "lucide-react";

import { useBookmarks, useHistory, usePinboards } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { timeAgo, hostnameOf, safeHref } from "@/lib/cowork-data/format";
import type { SampleBookmark } from "@/lib/cowork-data/types";

function BookmarkNode({ node, depth }: { node: SampleBookmark; depth: number }) {
  const isFolder = !node.url;
  return (
    <div style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
      {isFolder ? (
        <Accordion type="multiple" defaultValue={[node.id]}>
          <AccordionItem value={node.id} className="border-0">
            <AccordionTrigger className="py-1.5 hover:no-underline">
              <span className="flex items-center gap-2 text-sm font-medium">
                📁 {node.name}
              </span>
            </AccordionTrigger>
            <AccordionContent className="pb-1">
              {node.children?.map((c) => (
                <BookmarkNode key={c.id} node={c} depth={depth + 1} />
              ))}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : (
        <a
          href={safeHref(node.url)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 py-1.5 text-sm hover:bg-accent/50 rounded px-2 -mx-2 group"
        >
          <Bookmark className="size-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{node.name}</span>
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">
            {hostnameOf(node.url ?? "")}
          </span>
          <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 ml-auto shrink-0" />
        </a>
      )}
    </div>
  );
}

export function CollectionsView() {
  const { data: bookmarks, isLoading: bmLoading } = useBookmarks();
  const { data: history, isLoading: hLoading } = useHistory();
  const { data: pinboards, isLoading: pbLoading } = usePinboards();
  const [historyQuery, setHistoryQuery] = React.useState("");

  const historyFiltered = React.useMemo(() => {
    // `visitedAt` arrives as an ISO string (Prisma DateTime → JSON
    // serializes to string). Coerce to ms via `new Date(...).getTime()` so
    // the sort is stable.
    const all = (history ?? []).slice().sort(
      (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime(),
    );
    if (!historyQuery.trim()) return all;
    const q = historyQuery.toLowerCase();
    return all.filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
  }, [history, historyQuery]);

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Collections"
        description="Bookmarks, history and pinboards in one place"
        icon={<Bookmark className="size-5" />}
      />

      <Tabs defaultValue="bookmarks">
        <TabsList>
          <TabsTrigger value="bookmarks">
            <Bookmark className="size-3.5 mr-1.5" /> Bookmarks
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="size-3.5 mr-1.5" /> History
          </TabsTrigger>
          <TabsTrigger value="pinboards">
            <Pin className="size-3.5 mr-1.5" /> Pinboards
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bookmarks" className="mt-4">
          {bmLoading ? (
            <LoadingSkeleton rows={6} />
          ) : (bookmarks?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Bookmark className="size-6" />}
              title="No bookmarks"
              description="Bookmarks are added via POST /api/cowork/bookmarks. The cockpit dashboard is currently read-only."
            />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Card className="p-4 gap-1">
                {(bookmarks ?? []).map((b) => (
                  <BookmarkNode key={b.id} node={b} depth={0} />
                ))}
              </Card>
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <div className="flex justify-end mb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search history…"
                className="pl-8 h-9 w-56"
              />
            </div>
          </div>
          {hLoading ? (
            <LoadingSkeleton rows={8} />
          ) : historyFiltered.length === 0 ? (
            <EmptyState icon={<History className="size-6" />} title="No history" />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Card className="p-0 gap-0 overflow-hidden">
                <div className="divide-y">
                  {historyFiltered.map((h) => (
                    <a
                      key={h.id}
                      href={safeHref(h.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40"
                    >
                      <div className="size-6 rounded bg-muted text-muted-foreground grid place-items-center shrink-0 text-[10px] font-mono">
                        {hostnameOf(h.url).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{h.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{h.url}</p>
                      </div>
                      <span className="text-xs text-muted-foreground tnum shrink-0 hidden sm:inline">
                        {h.visitCount}× · {timeAgo(h.visitedAt)} ago
                      </span>
                    </a>
                  ))}
                </div>
              </Card>
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="pinboards" className="mt-4">
          {pbLoading ? (
            <LoadingSkeleton variant="cards" cardCount={4} />
          ) : (pinboards?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Bookmark className="size-6" />}
              title="No pinboards"
              description="Pinboards are created via POST /api/cowork/pinboards. The cockpit dashboard is currently read-only."
            />
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            >
              {(pinboards ?? []).map((pb) => (
                <Card key={pb.id} className="p-5 gap-2 hover:border-foreground/30 transition-colors">
                  <div className="text-2xl">{pb.emoji}</div>
                  <p className="font-semibold">{pb.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="tnum">{pb.itemCount}</span> items · updated {timeAgo(pb.updatedAt)} ago
                  </p>
                </Card>
              ))}
            </motion.div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
