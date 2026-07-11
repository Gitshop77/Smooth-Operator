"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";
import { DataTable } from "@/components/cowork/shared/data-table";
import { StatusPill, toneForStatus } from "@/components/cowork/shared/status-pill";
import { SearchInput } from "@/components/cowork/shared/search-input";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Skills view.
 *
 * Data source: the public `/api/cowork/skill` route returns a **markdown usage
 * guide** (see `cockpit/src/app/api/cowork/skill/route.ts`), not a JSON list of
 * skills. There is no endpoint that returns a structured skill catalog today,
 * so this view renders a sensible **local** list of built-in skills with a
 * functional enable/disable toggle held in component state. When a real skill
 * list endpoint lands, swap the local seed for a `useQuery` hook — the row
 * shape below already matches a `name / description / category / enabled` model.
 */

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

const INITIAL_SKILLS: Skill[] = [
  {
    id: "web-research",
    name: "Web Research",
    description: "Search the web, fetch sources, and synthesize cited findings.",
    category: "Research",
    enabled: true,
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review diffs for bugs, security issues, and maintainability.",
    category: "Engineering",
    enabled: true,
  },
  {
    id: "summarize",
    name: "Summarize",
    description: "Condense long pages, transcripts, or threads into key points.",
    category: "Writing",
    enabled: true,
  },
  {
    id: "data-extraction",
    name: "Data Extraction",
    description: "Pull structured records (tables, JSON, contacts) from pages.",
    category: "Automation",
    enabled: false,
  },
  {
    id: "form-filling",
    name: "Form Filling",
    description: "Autonomously complete forms using remembered field values.",
    category: "Automation",
    enabled: true,
  },
  {
    id: "navigation",
    name: "Navigation",
    description: "Open tabs, switch workspaces, and follow multi-step flows.",
    category: "Browser",
    enabled: true,
  },
  {
    id: "accessibility-audit",
    name: "Accessibility Audit",
    description: "Check pages against WCAG rules and suggest fixes.",
    category: "Quality",
    enabled: false,
  },
  {
    id: "security-scan",
    name: "Security Scan",
    description: "Detect prompt injection, secret leaks, and risky requests.",
    category: "Secure",
    enabled: true,
  },
];

export function SkillsView() {
  const [skills, setSkills] = React.useState<Skill[]>(INITIAL_SKILLS);
  const [filter, setFilter] = React.useState("");

  const visible = React.useMemo(() => {
    const all = skills;
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [skills, filter]);

  const enabledCount = skills.filter((s) => s.enabled).length;
  const categoryCount = new Set(skills.map((s) => s.category)).size;

  const toggle = React.useCallback((id: string) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  }, []);

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Skills"
        description="Reusable capabilities the agent can draw on. Enable or disable each skill locally."
        eyebrow="Build"
        icon={<Sparkles className="size-5" />}
        actions={
          <SearchInput
            value={filter}
            onChange={setFilter}
            ariaLabel="Filter skills"
            placeholder="Filter skills…"
            className="h-8 w-44 sm:w-52 text-sm"
          />
        }
      />

      <div className="grid gap-3 grid-cols-3">
        <StatCard label="Skills" value={skills.length} tone="accent" />
        <StatCard label="Enabled" value={enabledCount} tone="success" />
        <StatCard label="Categories" value={categoryCount} />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-5" />}
          title="No Skills Found"
          description="No skills match your filter. Clear the filter to see all available skills."
          action={
            filter ? (
              <Button size="sm" variant="outline" onClick={() => setFilter("")}>
                Clear Filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          caption="Available skills"
          columns={["Skill", "Category", "Description", "Status", "Enabled"]}
        >
          {visible.map((skill) => {
            const status = skill.enabled ? "enabled" : "disabled";
            return (
              <tr
                key={skill.id}
                className="hover:bg-accent/50 transition-colors border-l-[3px] border-transparent hover:border-primary"
              >
                <td className="px-4 py-2.5 min-w-[180px]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="size-6 rounded border border-primary/20 bg-primary/5 text-primary grid place-items-center shrink-0">
                      <Sparkles className="size-3.5" />
                    </div>
                    <span className="font-medium text-sm">{skill.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-xs cowork-mono text-muted-foreground">
                    {skill.category}
                  </span>
                </td>
                <td className="px-4 py-2.5 max-w-[420px]">
                  <span className="text-sm text-muted-foreground line-clamp-2">
                    {skill.description}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={toneForStatus(status)}>
                    {skill.enabled ? "Enabled" : "Disabled"}
                  </StatusPill>
                </td>
                <td className="px-4 py-2.5">
                  <Button
                    size="sm"
                    variant={skill.enabled ? "default" : "outline"}
                    aria-pressed={skill.enabled}
                    onClick={() => toggle(skill.id)}
                    className={cn("h-8")}
                  >
                    {skill.enabled ? "Disable" : "Enable"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}

      <Card className="p-3 text-[11px] text-muted-foreground cowork-mono">
        Showing <span className="tnum font-medium text-foreground">{visible.length}</span> of{" "}
        <span className="tnum font-medium text-foreground">{skills.length}</span> skills.
        {filter ? " (filtered)" : ""} Toggles are local to this session.
      </Card>
    </div>
  );
}
