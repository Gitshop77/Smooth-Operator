"use client";

import {
  AppWindow, LayoutGrid, Boxes, Bot, Workflow, Wrench,
  Activity, TerminalSquare, ListTree, Database, ShieldCheck,
  Bookmark, Puzzle, Sparkles, type LucideIcon,
} from "lucide-react";

import type { ViewId } from "@/hooks/use-cowork-store";

export interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  description?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Browsing",
    items: [
      { id: "tabs", label: "Tabs", icon: AppWindow, description: "Open browser tabs" },
      { id: "workspaces", label: "Workspaces", icon: LayoutGrid, description: "Tab collections" },
      { id: "sessions", label: "Sessions", icon: Boxes, description: "Isolated sessions" },
    ],
  },
  {
    label: "Agents",
    items: [
      { id: "agents", label: "Agents", icon: Bot, description: "Agents & tasks" },
      { id: "workflows", label: "Workflows", icon: Workflow, description: "Automations" },
      { id: "mcp", label: "MCP Tools", icon: Wrench, description: "MCP tool registry" },
    ],
  },
  {
    label: "Inspect",
    items: [
      { id: "network", label: "Network", icon: Activity, description: "Live requests" },
      { id: "devtools", label: "DevTools", icon: TerminalSquare, description: "Console logs" },
      { id: "snapshots", label: "Snapshots", icon: ListTree, description: "AX tree" },
      { id: "memory", label: "Memory", icon: Database, description: "Site & form memory" },
    ],
  },
  {
    label: "Secure",
    items: [
      { id: "security", label: "Security", icon: ShieldCheck, description: "Event feed" },
    ],
  },
  {
    label: "Collections",
    items: [
      { id: "collections", label: "Collections", icon: Bookmark, description: "Bookmarks · History · Pinboards" },
      { id: "extensions", label: "Extensions", icon: Puzzle, description: "Installed extensions" },
    ],
  },
  {
    label: "AI",
    items: [
      { id: "chat", label: "AI Chat", icon: Sparkles, description: "Wingman chat" },
    ],
  },
];

/** Flat lookup of view id → {label, icon, description}. */
export const VIEW_META: Record<ViewId, { label: string; icon: LucideIcon; description: string }> =
  Object.fromEntries(
    NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => [i.id, { label: i.label, icon: i.icon, description: i.description ?? "" }]),
    ),
  ) as Record<ViewId, { label: string; icon: LucideIcon; description: string }>;
