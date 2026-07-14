"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * View ids — the canonical set wired through the sidebar (nav-config), the
 * view router (cowork-shell), and the store. Grouped per REDESIGN-PLAN §5.1:
 * Observe : overview, runs-history, logs, errors, cost, sessions, tabs,
 * workspaces, network, snapshots, devtools
 * Build : agents, workflows, mcp-tools, skills, prompts, memory,
 * collections, extensions, chat
 * Secure : security
 * Settings : settings
 * Depth views (no nav entry of their own): session-replay, run-detail.
 * Extension-only: tabs, workspaces, network, snapshots, devtools.
 */
export type ViewId =
  | "overview"
  | "runs-history"
  | "logs"
  | "errors"
  | "cost"
  | "sessions"
  | "tabs"
  | "workspaces"
  | "network"
  | "snapshots"
  | "devtools"
  | "agents"
  | "workflows"
  | "mcp-tools"
  | "skills"
  | "prompts"
  | "memory"
  | "collections"
  | "extensions"
  | "chat"
  | "security"
  | "settings"
  | "session-replay"
  | "run-detail";

/**
 * Views that only have meaning when the browser extension is connected. These
 * must never be restored from the persisted store on a cold open (reload
 * without the extension), or the user would land on an empty extension-only
 * state. The store still defaults to `overview` in that case.
 */
const EXTENSION_ONLY_VIEWS = new Set<ViewId>([
  "tabs",
  "workspaces",
  "network",
  "snapshots",
  "devtools",
]);

const ALL_VIEW_IDS: ReadonlySet<ViewId> = new Set<ViewId>([
  "overview", "runs-history", "logs", "errors", "cost", "sessions", "tabs",
  "workspaces", "network", "snapshots", "devtools", "agents", "workflows",
  "mcp-tools", "skills", "prompts", "memory", "collections", "extensions",
  "chat", "security", "settings", "session-replay", "run-detail",
]);

interface CoworkState {
  /** Active dashboard view. */
  currentView: ViewId;
  /**
 * Optional context payload for the active view. Depth views consume it —
 * `run-detail` reads `runId`, `session-replay` reads `sessionId` — so a row
 * click in a list view can deep-link into a specific record without
 * round-tripping through the URL. Top-level views leave it `null`.
 */
  viewParams: Record<string, string> | null;
  /** Mobile sidebar (Sheet) open state. */
  sidebarOpen: boolean;
  /** Desktop sidebar collapsed (icon-rail) state. */
  sidebarCollapsed: boolean;
  /** Whether the live event socket (port 3003) is connected. */
  socketConnected: boolean;
  /** Last event received over the socket, shown in the footer. */
  lastEvent: string | null;
  /** Navigate to a view, optionally carrying context (e.g. a run id / session id). */
  setView: (v: ViewId, params?: Record<string, string>) => void;
  setSidebar: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSocketConnected: (c: boolean) => void;
  setLastEvent: (e: string | null) => void;
}

export const useCoworkStore = create<CoworkState>()(
  persist(
    (set) => ({
 // Default to a built-in dashboard (overview) rather than an extension-only
 // view (tabs). tabs is wired for when the browser extension is connected; a
 // cold-open of the cockpit without the extension should land on a meaningful
 // built-in view, not an empty-state extension view.
      currentView: "overview",
      viewParams: null,
      sidebarOpen: false,
      sidebarCollapsed: false,
      socketConnected: false,
      lastEvent: null,
      setView: (v, params) =>
        set({ currentView: v, viewParams: params ?? null, sidebarOpen: false }),
      setSidebar: (open) => set({ sidebarOpen: open }),
      toggleSidebarCollapsed: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSocketConnected: (c) => set({ socketConnected: c }),
      setLastEvent: (e) => set({ lastEvent: e }),
    }),
    {
      name: "cowork-ui",
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        // Only restore built-in (non-extension-only) views so a reload without
        // the extension never lands on an empty extension-only view.
        ...(EXTENSION_ONLY_VIEWS.has(s.currentView)
          ? {}
          : { currentView: s.currentView }),
      }),
      // Read-side sanitization: partialize only controls what is *written*, so a
      // view persisted by older code (or a schema-drifted value) could be
      // *restored* on rehydrate. Clamp to `overview` unless the restored view is
      // a known, non-extension-only ViewId — closing the cold-open gap.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CoworkState>;
        const restored = p.currentView;
        const safeView =
          restored != null && !EXTENSION_ONLY_VIEWS.has(restored) && ALL_VIEW_IDS.has(restored)
            ? restored
            : "overview";
        return { ...current, ...p, currentView: safeView } as CoworkState;
      },
    },
  ),
);
