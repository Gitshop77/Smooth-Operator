"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Bookmark, History, Pin, ExternalLink, Folder, AlertCircle, RotateCcw } from "lucide-react";

import { useBookmarks, useHistory, usePinboards } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/cowork/shared/data-table";
import { SearchInput } from "@/components/cowork/shared/search-input";
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
                <Folder className="size-4 text-muted-foreground" />
                {node.name}
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
          <span className="sr-only"> (opens in new tab)</span>
          <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100 ml-auto shrink-0" />
        </a>
      )}
    </div>
  );
}

export function CollectionsView() {
  const { data: bookmarks, isLoading: bmLoading, isError: bmError, refetch: refetchBookmarks } = useBookmarks();
  const { data: history, isLoading: hLoading, isError: hError, refetch: refetchHistory } = useHistory();
  const { data: pinboards, isLoading: pbLoading, isError: pbError, refetch: refetchPinboards } = usePinboards();
  const [historyQuery, setHistoryQuery] = React.useState("");

  const enriched = React.useMemo(
    () =>
      (history ?? []).map((e) => ({
        ...e,
        _ts: new Date(e.visitedAt).getTime(),
        _title: e.title.toLowerCase(),
        _url: e.url.toLowerCase(),
      })),
    [history],
  );
  const sortedHistory = React.useMemo(
    () => enriched.slice().sort((a, b) => b._ts - a._ts),
    [enriched],
  );
  const historyFiltered = React.useMemo(() => {
    if (!historyQuery.trim()) return sortedHistory;
    const q = historyQuery.toLowerCase();
    return sortedHistory.filter(
      (e) => e._title.includes(q) || e._url.includes(q),
    );
  }, [sortedHistory, historyQuery]);

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
          ) : bmError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load bookmarks"
              description="The bookmarks endpoint returned an error. Try again shortly."
              action={
                <Button size="sm" variant="outline" onClick={() => refetchBookmarks()}>
                  <RotateCcw className="size-3.5 mr-1" /> Retry
                </Button>
              }
            />
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
            <SearchInput
              value={historyQuery}
              onChange={setHistoryQuery}
              ariaLabel="Search history"
              placeholder="Search history…"
              className="w-56"
            />
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {historyFiltered.length} history entries shown
          </p>
          {hLoading ? (
            <LoadingSkeleton rows={8} />
          ) : hError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load history"
              description="The history endpoint returned an error. Try again shortly."
              action={
                <Button size="sm" variant="outline" onClick={() => refetchHistory()}>
                  <RotateCcw className="size-3.5 mr-1" /> Retry
                </Button>
              }
            />
          ) : historyFiltered.length === 0 ? (
            <EmptyState
              icon={<History className="size-6" />}
              title={historyQuery.trim() ? "No matching history" : "No history"}
              description={
                historyQuery.trim()
                  ? `No history entries match “${historyQuery}”.`
                  : undefined
              }
            />
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <DataTable caption="Browsing history" columns={["Page", "Visits"]}>
                {historyFiltered.map((h) => (
                  <tr key={h.id} className="hover:bg-accent/40 transition-colors align-top">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="size-6 rounded bg-muted text-muted-foreground grid place-items-center shrink-0 text-[10px] font-mono">
                          {hostnameOf(h.url).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <a
                            href={safeHref(h.url)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm truncate hover:text-primary hover:underline block max-w-[420px]"
                            title={h.url}
                          >
                            {h.title}
                            <span className="sr-only"> (opens in new tab)</span>
                          </a>
                          <p className="text-xs text-muted-foreground cowork-mono truncate">{h.url}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground tnum whitespace-nowrap">
                      {h.visitCount}× · {timeAgo(h.visitedAt)} ago
                    </td>
                  </tr>
                ))}
              </DataTable>
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="pinboards" className="mt-4">
          {pbLoading ? (
            <LoadingSkeleton variant="cards" cardCount={4} />
          ) : pbError ? (
            <EmptyState
              icon={<AlertCircle className="size-6" />}
              title="Couldn't load pinboards"
              description="The pinboards endpoint returned an error. Try again shortly."
              action={
                <Button size="sm" variant="outline" onClick={() => refetchPinboards()}>
                  <RotateCcw className="size-3.5 mr-1" /> Retry
                </Button>
              }
            />
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
                  <div className="size-10 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                    <Pin className="size-5" />
                  </div>
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
