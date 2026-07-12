"use client";

import { create } from "zustand";

/**
 * View ids — the canonical set wired through the sidebar (nav-config), the
 * view router (cowork-shell), and the store. Grouped per REDESIGN-PLAN §5.1:
 *   Observe  : overview, runs-history, logs, errors, cost, sessions, tabs,
 *              workspaces, network, snapshots, devtools
 *   Build    : agents, workflows, mcp-tools, skills, prompts, memory,
 *              collections, extensions, chat
 *   Secure   : security
 *   Settings : settings
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

export const useCoworkStore = create<CoworkState>((set) => ({
  currentView: "tabs",
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
}));
