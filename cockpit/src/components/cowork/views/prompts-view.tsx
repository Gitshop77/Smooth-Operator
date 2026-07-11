"use client";

import * as React from "react";
import { FileText, Plus, Trash2, MessageSquarePlus } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { cn } from "@/lib/utils";

/**
 * Prompts view.
 *
 * Mirrors the extension Options → Prompts tab (see
 * `src/extension/options/prompts.ts`): a single default system prompt plus a
 * quick-prompt CRUD list. State is **local** to this view (the cockpit has no
 * prompts persistence endpoint — the canonical store lives in the extension's
 * `chrome.storage.local`). Add/remove are fully functional via `useState`.
 *
 * No `textarea.tsx` primitive ships with the cockpit UI kit, so a token-driven
 * local `Textarea` is defined here to match the `Input` styling exactly.
 */

interface QuickPrompt {
  id: string;
  name: string;
  text: string;
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input flex w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm",
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        "resize-y",
        className,
      )}
      {...props}
    />
  );
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Open Cowork, a careful browsing agent. Follow the user's mission, " +
  "verify before acting, and summarize what you did.";

let quickPromptSeq = 0;
const nextId = () => `qp-${Date.now()}-${quickPromptSeq++}`;

export function PromptsView() {
  const [systemPrompt, setSystemPrompt] = React.useState(DEFAULT_SYSTEM_PROMPT);
  const [quickPrompts, setQuickPrompts] = React.useState<QuickPrompt[]>([]);
  const [newName, setNewName] = React.useState("");
  const [newText, setNewText] = React.useState("");

  const addQuickPrompt = React.useCallback(() => {
    const name = newName.trim();
    const text = newText.trim();
    if (!name || !text) return;
    setQuickPrompts((prev) => {
      const idx = prev.findIndex((q) => q.name === name);
      const entry: QuickPrompt = { id: nextId(), name, text };
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = entry;
        return copy;
      }
      return [...prev, entry];
    });
    setNewName("");
    setNewText("");
  }, [newName, newText]);

  const removeQuickPrompt = React.useCallback((id: string) => {
    setQuickPrompts((prev) => prev.filter((q) => q.id !== id));
  }, []);

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Prompts"
        description="Default system prompt and quick prompts the agent can use. Changes are local to this session."
        eyebrow="Build"
        icon={<FileText className="size-5" />}
      />

      {/* Default system prompt */}
      <Card className="p-4 sm:p-5">
        <div className="space-y-1.5">
          <label
            htmlFor="system-prompt"
            className="text-sm font-medium text-foreground inline-flex items-center gap-2"
          >
            <FileText className="size-4 text-primary" />
            Default System Prompt
          </label>
          <p className="text-xs text-muted-foreground">
            Used as the base instruction for every agent run.
          </p>
        </div>
        <Textarea
          id="system-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder="Enter the default system prompt…"
          className="mt-3 text-sm"
        />
        <p className="mt-2 text-[11px] text-muted-foreground cowork-mono tnum">
          <span className="font-medium text-foreground">{systemPrompt.length}</span> characters
        </p>
      </Card>

      {/* Quick prompts CRUD */}
      <Card className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground inline-flex items-center gap-2">
              <MessageSquarePlus className="size-4 text-primary" />
              Quick Prompts
            </p>
            <p className="text-xs text-muted-foreground">
              Reusable one-line prompts you can fire quickly.
            </p>
          </div>
          <span className="text-xs cowork-mono text-muted-foreground tnum">
            {quickPrompts.length}
          </span>
        </div>

        {/* Add row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g. Summarize)"
            aria-label="Quick prompt name"
            className="sm:w-48 shrink-0"
          />
          <Textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Prompt text…"
            aria-label="Quick prompt text"
            rows={2}
            className="text-sm flex-1"
          />
          <Button
            type="button"
            onClick={addQuickPrompt}
            disabled={!newName.trim() || !newText.trim()}
            className="shrink-0 sm:mt-0.5"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add</span>
          </Button>
        </div>

        {/* List */}
        <div className="mt-4 space-y-2">
          {quickPrompts.length === 0 ? (
            <EmptyState
              icon={<MessageSquarePlus className="size-5" />}
              title="No Quick Prompts"
              description="Add a named quick prompt above to reuse it later."
              className="py-10"
            />
          ) : (
            quickPrompts.map((q) => (
              <div
                key={q.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{q.name}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {q.text}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete quick prompt ${q.name}`}
                  onClick={() => removeQuickPrompt(q.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
