"use client";

import {
  LayoutDashboard, History, ScrollText, AlertTriangle, CircleDollarSign,
  Boxes, AppWindow, LayoutGrid, Activity, ListTree, TerminalSquare,
  Bot, Workflow, Wrench, Sparkles, FileText, Database, Bookmark, Puzzle,
  MessagesSquare, ShieldCheck, Settings, type LucideIcon,
} from "lucide-react";

import type { ViewId } from "@/hooks/use-cowork-store";

export interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  description?: string;
  /**
   * True for views that depend on a live extension connection (browser tabs,
   * workspaces, network, snapshots, devtools). The shell renders an
   * <ExtensionOnly> standby state for these when no extension data is present.
   */
  extensionOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Observe",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard, description: "Fleet health at a glance" },
      { id: "runs-history", label: "Runs & History", icon: History, description: "Runs, history & transcripts" },
      { id: "logs", label: "Logs Explorer", icon: ScrollText, description: "Cross-agent log stream" },
      { id: "errors", label: "Errors & Incidents", icon: AlertTriangle, description: "Errors & incidents" },
      { id: "cost", label: "Cost & Usage", icon: CircleDollarSign, description: "Spend & token usage" },
      { id: "sessions", label: "Sessions", icon: Boxes, description: "Isolated sessions" },
      { id: "tabs", label: "Tabs", icon: AppWindow, description: "Open browser tabs", extensionOnly: true },
      { id: "workspaces", label: "Workspaces", icon: LayoutGrid, description: "Tab collections", extensionOnly: true },
      { id: "network", label: "Network", icon: Activity, description: "Live requests", extensionOnly: true },
      { id: "snapshots", label: "Snapshots", icon: ListTree, description: "AX tree", extensionOnly: true },
      { id: "devtools", label: "DevTools", icon: TerminalSquare, description: "Console logs", extensionOnly: true },
    ],
  },
  {
    label: "Build",
    items: [
      { id: "agents", label: "Agents", icon: Bot, description: "Agents & tasks" },
      { id: "workflows", label: "Workflows", icon: Workflow, description: "Automations" },
      { id: "mcp-tools", label: "MCP Tools", icon: Wrench, description: "MCP tool registry" },
      { id: "skills", label: "Skills", icon: Sparkles, description: "Reusable skills" },
      { id: "prompts", label: "Prompts", icon: FileText, description: "System prompts" },
      { id: "memory", label: "Memory", icon: Database, description: "Site & form memory" },
      { id: "collections", label: "Collections", icon: Bookmark, description: "Bookmarks · History · Pinboards" },
      { id: "extensions", label: "Extensions", icon: Puzzle, description: "Installed extensions" },
      { id: "chat", label: "AI Chat", icon: MessagesSquare, description: "Wingman chat" },
    ],
  },
  {
    label: "Secure",
    items: [
      { id: "security", label: "Security", icon: ShieldCheck, description: "Event feed" },
    ],
  },
  {
    label: "Settings",
    items: [
      { id: "settings", label: "Settings", icon: Settings, description: "Appearance & config" },
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
