"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useCoworkWebSocket } from "@/hooks/use-websocket";
import { AppErrorBoundary } from "@/components/cowork/providers";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { ExtensionOnly } from "@/components/cowork/shared/extension-only";
import { VIEW_META } from "@/components/layout/nav-config";

// Existing views — imports kept as-is.
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

// New views — wired into the dashboard. Their modules exist and the cockpit
// build is expected to pass; this mapping keeps each view addressable by id.
import { OverviewView } from "@/components/cowork/views/overview-view";
import { RunsHistoryView } from "@/components/cowork/views/runs-history-view";
import { RunDetailView } from "@/components/cowork/views/run-detail-view";
import { LogsExplorerView } from "@/components/cowork/views/logs-explorer-view";
import { ErrorsView } from "@/components/cowork/views/errors-view";
import { CostView } from "@/components/cowork/views/cost-view";
import { SessionReplayView } from "@/components/cowork/views/session-replay-view";
import { SettingsView } from "@/components/cowork/views/settings-view";
import { SkillsView } from "@/components/cowork/views/skills-view";
import { PromptsView } from "@/components/cowork/views/prompts-view";

import type { ViewId } from "@/hooks/use-cowork-store";

const VIEWS: Record<ViewId, React.ComponentType> = {
 // Observe
  overview: OverviewView,
  "runs-history": RunsHistoryView,
  logs: LogsExplorerView,
  errors: ErrorsView,
  cost: CostView,
  sessions: SessionsView,
  tabs: TabsView,
  workspaces: WorkspacesView,
  network: NetworkView,
  snapshots: SnapshotsView,
  devtools: DevToolsView,
 // Build
  agents: AgentsView,
  workflows: WorkflowsView,
  "mcp-tools": McpToolsView,
  skills: SkillsView,
  prompts: PromptsView,
  memory: MemoryView,
  collections: CollectionsView,
  extensions: ExtensionsView,
  chat: ChatView,
 // Secure
  security: SecurityView,
 // Settings
  settings: SettingsView,
 // Depth views (no nav entry)
  "session-replay": SessionReplayView,
  "run-detail": RunDetailView,
};

/**
 * View ids that depend on a live extension connection. When no extension data
 * is present the shell renders the shared <ExtensionOnly> standby (created in
 * the primitives phase) instead of — or wrapping — the live view.
 */
const EXTENSION_ONLY_IDS = new Set<ViewId>([
  "tabs",
  "workspaces",
  "network",
  "snapshots",
  "devtools",
]);

/**
 * CoworkShell — the whole dashboard layout.
 *
 * Structure (critical for the sticky footer requirement):
 * <div min-h-screen flex flex-col> ← root
 * <div flex flex-1 min-h-screen> ← row: sidebar + main
 * <aside sticky top-0 h-screen> ← desktop sidebar (mobile uses Sheet)
 * <div flex-1 flex flex-col> ← main column
 * <Header sticky top-0> ← sticky header
 * <main flex-1> ← content grows, pushing footer down
 * <Footer> ← mt-auto backup
 */
export function CoworkShell() {
  const currentView = useCoworkStore((s) => s.currentView);
  const socketConnected = useCoworkStore((s) => s.socketConnected);
  const socketStatus = useCoworkStore((s) => s.socketStatus);
  useCoworkWebSocket();

  const [bannerDismissed, setBannerDismissed] = React.useState(false);

  // Re-arm the banner whenever the socket reconnects — intentional sync of
  // local UI state to the external socket-connection signal.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (socketConnected) setBannerDismissed(false);
  }, [socketConnected]);

  const View = VIEWS[currentView] ?? TabsView;
  const isExtensionOnly = EXTENSION_ONLY_IDS.has(currentView);
  const meta = VIEW_META[currentView];

  const showOfflineBanner = socketStatus === "disconnected" && !bannerDismissed;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen flex flex-col bg-background">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:shadow focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <div className="flex flex-1 min-h-screen">
          {/* Desktop sidebar — 240px (w-60), collapses to an icon rail. */}
          <aside className="hidden md:flex shrink-0 sticky top-0 h-screen border-r border-border">
            <Sidebar className="border-r-0" />
          </aside>

          {/* Main column */}
          <div className="flex-1 flex flex-col min-w-0">
            <Header />
            {showOfflineBanner && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground"
              >
                <span>
                  Connection to the Open Cowork service is down — data shown may
                  be stale. Reconnect the extension or check the service, then
                  reload.
                </span>
                <button
                  type="button"
                  onClick={() => setBannerDismissed(true)}
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
                >
                  Dismiss
                </button>
              </div>
            )}
            <main id="main-content" tabIndex={-1} className="flex-1 p-4 sm:p-6 cowork-scroll outline-none">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentView}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="mx-auto max-w-7xl"
                >
                  <AppErrorBoundary key={currentView}>
                    {isExtensionOnly ? (
                      socketConnected ? (
                        <View />
                      ) : (
                        <ExtensionOnly
                          title={`${meta?.label ?? "This view"} needs the extension`}
                          description="This view reflects live data from the Open Cowork browser extension. Connect the extension to see it here."
                        />
                      )
                    ) : (
                      <View />
                    )}
                  </AppErrorBoundary>
                </motion.div>
              </AnimatePresence>
            </main>
            <Footer />
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
