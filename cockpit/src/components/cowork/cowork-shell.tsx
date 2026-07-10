"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useCoworkWebSocket } from "@/hooks/use-websocket";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";

import { TabsView } from "@/components/cowork/views/tabs-view";
import { WorkspacesView } from "@/components/cowork/views/workspaces-view";
import { AgentsView } from "@/components/cowork/views/agents-view";
import { WorkflowsView } from "@/components/cowork/views/workflows-view";
import { NetworkView } from "@/components/cowork/views/network-view";
import { DevToolsView } from "@/components/cowork/views/devtools-view";
import { SnapshotsView } from "@/components/cowork/views/snapshots-view";
import { SecurityView } from "@/components/cowork/views/security-view";
import { SessionsView } from "@/components/cowork/views/sessions-view";
import { ExtensionsView } from "@/components/cowork/views/extensions-view";
import { MemoryView } from "@/components/cowork/views/memory-view";
import { McpToolsView } from "@/components/cowork/views/mcp-tools-view";
import { CollectionsView } from "@/components/cowork/views/collections-view";
import { ChatView } from "@/components/cowork/views/chat-view";
import type { ViewId } from "@/hooks/use-cowork-store";

const VIEWS: Record<ViewId, React.ComponentType> = {
  tabs: TabsView,
  workspaces: WorkspacesView,
  sessions: SessionsView,
  agents: AgentsView,
  workflows: WorkflowsView,
  mcp: McpToolsView,
  network: NetworkView,
  devtools: DevToolsView,
  snapshots: SnapshotsView,
  memory: MemoryView,
  security: SecurityView,
  collections: CollectionsView,
  extensions: ExtensionsView,
  chat: ChatView,
};

/**
 * CoworkShell — the whole dashboard layout.
 *
 * Structure (critical for the sticky footer requirement):
 *   <div min-h-screen flex flex-col>      ← root
 *     <div flex flex-1 min-h-screen>      ← row: sidebar + main
 *       <aside sticky top-0 h-screen>     ← desktop sidebar (mobile uses Sheet)
 *       <div flex-1 flex flex-col>        ← main column
 *         <Header sticky top-0>           ← sticky header
 *         <main flex-1>                   ← content grows, pushing footer down
 *         <Footer>                        ← mt-auto backup
 */
export function CoworkShell() {
  const currentView = useCoworkStore((s) => s.currentView);
  useCoworkWebSocket();

  const View = VIEWS[currentView] ?? TabsView;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex flex-1 min-h-screen">
        {/* Desktop sidebar — 224px */}
        <aside className="hidden md:flex w-56 shrink-0 sticky top-0 h-screen border-r border-border">
          <Sidebar className="border-r-0" />
        </aside>

        {/* Main column */}
        <div className="flex-1 flex flex-col min-w-0">
          <Header />
          <main className="flex-1 p-4 sm:p-6 cowork-scroll">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentView}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="mx-auto max-w-7xl"
              >
                <View />
              </motion.div>
            </AnimatePresence>
          </main>
          <Footer />
        </div>
      </div>
    </div>
  );
}
