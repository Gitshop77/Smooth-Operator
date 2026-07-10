"use client";

import { create } from "zustand";

export type ViewId =
  | "tabs"
  | "workspaces"
  | "sessions"
  | "agents"
  | "workflows"
  | "mcp"
  | "network"
  | "devtools"
  | "snapshots"
  | "memory"
  | "security"
  | "collections"
  | "extensions"
  | "chat";

interface CoworkState {
  /** Active dashboard view. */
  currentView: ViewId;
  /** Mobile sidebar (Sheet) open state. */
  sidebarOpen: boolean;
  /** Whether the live event socket (port 3003) is connected. */
  socketConnected: boolean;
  /** Last event received over the socket, shown in the footer. */
  lastEvent: string | null;
  setView: (v: ViewId) => void;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  setSocketConnected: (c: boolean) => void;
  setLastEvent: (e: string | null) => void;
}

export const useCoworkStore = create<CoworkState>((set) => ({
  currentView: "tabs",
  sidebarOpen: false,
  socketConnected: false,
  lastEvent: null,
  setView: (v) => set({ currentView: v, sidebarOpen: false }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  setSocketConnected: (c) => set({ socketConnected: c }),
  setLastEvent: (e) => set({ lastEvent: e }),
}));
