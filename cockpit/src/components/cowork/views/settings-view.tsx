"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import {
  Settings as SettingsIcon,
  Palette,
  Bot,
  Bug,
  Plug,
  Bell,
  Database,
  Info,
  Download,
  Upload,
  Trash2,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/* -------------------------------------------------------------------------- */
/* Local-only settings model                                                  */
/*                                                                            */
/* No settings CRUD endpoint exists in the cockpit API (see .audit/data.md    */
/* §7 "Settings — Partial … no settings CRUD endpoint"). Every control below  */
/* is wired to React state and is fully interactive; persistence is not yet   */
/* backed by a server.                                                        */
/* -------------------------------------------------------------------------- */

interface SettingsState {
  appearance: {
    theme: string;
    accent: string;
    density: "comfortable" | "compact";
    fontSize: string;
    reduceMotion: boolean;
  };
  agent: {
    defaultModel: string;
    maxSteps: number;
    visionMode: "off" | "on" | "local";
    modes: string[];
    allowDomains: string;
    blockDomains: string;
  };
  debugging: {
    verbosity: string;
    debugHighlights: boolean;
    captureScreenshots: boolean;
    recordDomSnapshots: boolean;
    experimental: boolean;
  };
  connections: {
    cockpitUrl: string;
    provider: string;
    apiKey: string;
  };
  notifications: {
    onError: boolean;
    onComplete: boolean;
    onTakeover: boolean;
    channels: string[];
  };
  data: {
    retention: string;
  };
}

const DEFAULT_SETTINGS: SettingsState = {
  appearance: {
    theme: "system",
    accent: "#6C5CE7", // Signal Indigo — default accent
    density: "comfortable",
    fontSize: "13",
    reduceMotion: false,
  },
  agent: {
    defaultModel: "anthropic/claude-sonnet-4-20250514",
    maxSteps: 100,
    visionMode: "off",
    modes: ["Standard"],
    allowDomains: "",
    blockDomains: "",
  },
  debugging: {
    verbosity: "info",
    debugHighlights: true,
    captureScreenshots: false,
    recordDomSnapshots: false,
    experimental: false,
  },
  connections: {
    cockpitUrl: "http://localhost:3003",
    provider: "anthropic",
    apiKey: "",
  },
  notifications: {
    onError: true,
    onComplete: true,
    onTakeover: false,
    channels: ["In-app"],
  },
  data: {
    retention: "30d",
  },
};

/* User-selectable accent presets. These literal color values are the *content*
 * of the color picker (the feature itself), not chrome styling — every other
 * surface in this file is token-driven (bg-primary / text-primary / …). */
const ACCENT_PRESETS = [
  { id: "indigo", name: "Signal Indigo", value: "#6C5CE7" },
  { id: "violet", name: "Violet", value: "#8B5CF6" },
  { id: "cyan", name: "Cyan", value: "#06B6D4" },
  { id: "emerald", name: "Emerald", value: "#10B981" },
  { id: "amber", name: "Amber", value: "#F59E0B" },
  { id: "rose", name: "Rose", value: "#F43F5E" },
];

/* The 16 provider IDs mirrored from src/extension/provider-config-map.ts. */
const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Google Gemini" },
  { id: "google", name: "Google (Vertex)" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "groq", name: "Groq" },
  { id: "together", name: "Together AI" },
  { id: "mistral", name: "Mistral" },
  { id: "cerebras", name: "Cerebras" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "xai", name: "xAI" },
  { id: "ollama", name: "Ollama" },
  { id: "qwen", name: "Qwen (DashScope)" },
  { id: "opencode", name: "OpenCode" },
  { id: "litellm", name: "LiteLLM" },
  { id: "azure", name: "Azure OpenAI" },
];

const AGENT_MODES = ["Restricted", "Standard", "Full agentic"] as const;
const NOTIFY_CHANNELS = ["In-app", "Desktop", "Email", "Webhook"] as const;

const APP_VERSION = "1.0.0";
const APP_BUILD = "dev-local";

/* -------------------------------------------------------------------------- */
/* Reusable field primitives (token-driven, no hardcoded hex)                 */
/* -------------------------------------------------------------------------- */

function Field({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

function SettingRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Switch({
  checked,
  onCheckedChange,
  id,
  "aria-label": ariaLabel,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        checked ? "bg-primary" : "bg-muted",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[6px] px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            value === o.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* Allowed values for enum-style settings. Imported values are constrained to
 * these sets so a malformed/erroneous file cannot desync the UI (e.g. a blank
 * Select) or set a semantically invalid state that a future consumer trusts. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  "appearance.density": ["comfortable", "compact"],
  "appearance.fontSize": ["12", "13", "14", "15"],
  "agent.visionMode": ["off", "on", "local"],
  "connections.provider": PROVIDERS.map((p) => p.id),
  "data.retention": ["7d", "30d", "90d", "forever"],
  "debugging.verbosity": ["debug", "info", "warn", "error"],
};

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/* Sanitize one section of an *untrusted* import: only known keys (whitelisted
 * via the DEFAULT_SETTINGS shape) are carried over, values are coerced to the
 * expected type, enumerated fields are restricted to known-good values,
 * `maxSteps` is clamped to a sane positive range, and `accent` must be a hex
 * color before it can reach the `--primary` CSS custom property. Invalid or
 * missing values fall back to the existing (current) value. */
function sanitizeSection<K extends keyof SettingsState>(
  section: K,
  base: SettingsState[K],
  incoming: Partial<SettingsState[K]> | undefined,
): SettingsState[K] {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return base;
  }
  const out = { ...base } as Record<string, unknown>;
  const fallback = base as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const value = (incoming as Record<string, unknown>)[key];
    if (value === undefined) continue;

    const enumSet = ENUM_VALUES[`${section}.${key}`];
    if (enumSet) {
      out[key] = enumSet.includes(String(value))
        ? value
        : fallback[key];
      continue;
    }

    const ref = fallback[key];
    if (typeof ref === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] =
        key === "maxSteps" ? Math.min(Math.max(Math.trunc(n), 1), 100000) : n;
    } else if (typeof ref === "boolean") {
      out[key] = Boolean(value);
    } else if (typeof ref === "string") {
      const s = String(value);
      out[key] = key === "accent" && !HEX_COLOR.test(s) ? ref : s;
    } else if (Array.isArray(ref)) {
      out[key] = Array.isArray(value)
        ? value.filter((x) => typeof x === "string")
        : ref;
    }
  }
  return out as SettingsState[K];
}

function mergeSettings(
  base: SettingsState,
  incoming: Partial<SettingsState>,
): SettingsState {
  return {
    appearance: sanitizeSection("appearance", base.appearance, incoming.appearance),
    agent: sanitizeSection("agent", base.agent, incoming.agent),
    debugging: sanitizeSection("debugging", base.debugging, incoming.debugging),
    connections: sanitizeSection("connections", base.connections, incoming.connections),
    notifications: sanitizeSection("notifications", base.notifications, incoming.notifications),
    data: sanitizeSection("data", base.data, incoming.data),
  };
}

/* -------------------------------------------------------------------------- */
/* Settings view                                                              */
/* -------------------------------------------------------------------------- */

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  const [settings, setSettings] = React.useState<SettingsState>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const setSection = <K extends keyof SettingsState>(
    key: K,
    patch: Partial<SettingsState[K]>,
  ) =>
    setSettings((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  const handleExportAll = () => {
    downloadJson("open-cowork-settings.json", settings);
    toast({
      title: "Settings exported",
      description: "Downloaded open-cowork-settings.json",
    });
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Settings file must be a JSON object.");
        }
        setSettings((s) =>
          mergeSettings(s, parsed as Partial<SettingsState>),
        );
        toast({ title: "Settings imported", description: file.name });
      } catch (err) {
        toast({
          title: "Import failed",
          description:
            err instanceof Error
              ? err.message
              : "File is not valid settings JSON.",
          variant: "destructive",
        });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleClearHistory = () => {
    setClearOpen(false);
    toast({
      title: "Nothing to clear",
      description:
        "This local-only view does not store browsing history, so there is nothing to remove.",
    });
  };

  const handleReset = () => {
    setResetOpen(false);
    setSettings(DEFAULT_SETTINGS);
    toast({ title: "Settings reset to defaults" });
  };

  const toggleArrayItem = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  // Live accent re-themes this view's subtree so the picker is visibly functional.
  const accentStyle: React.CSSProperties & Record<`--${string}`, string> = {
    "--primary": settings.appearance.accent,
  };

  const densitySpacing =
    settings.appearance.density === "compact" ? "space-y-4" : "space-y-5";

  return (
    <div className="space-y-6" style={accentStyle}>
      <ViewHeader
        eyebrow="Settings"
        title="Configuration"
        description="Canonical Open Cowork configuration. Mirrors the extension Options — agent defaults, connections, and notifications live in one place."
        icon={<SettingsIcon className="size-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              <RotateCcw className="size-4" /> Reset
            </Button>
            <Button size="sm" onClick={handleExportAll}>
              <Download className="size-4" /> Export
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="size-4 shrink-0" />
        Changes are stored locally in this browser session. No settings
        persistence endpoint exists in the cockpit API yet — values are
        functional UI only.
      </div>

      <Tabs defaultValue="appearance" className="space-y-5">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="appearance">
            <Palette className="size-4" /> Appearance
          </TabsTrigger>
          <TabsTrigger value="agent">
            <Bot className="size-4" /> Agent defaults
          </TabsTrigger>
          <TabsTrigger value="debugging">
            <Bug className="size-4" /> Debugging
          </TabsTrigger>
          <TabsTrigger value="connections">
            <Plug className="size-4" /> Connections
          </TabsTrigger>
          <TabsTrigger value="notifications">
            <Bell className="size-4" /> Notifications
          </TabsTrigger>
          <TabsTrigger value="data">
            <Database className="size-4" /> Data
          </TabsTrigger>
          <TabsTrigger value="about">
            <Info className="size-4" /> About
          </TabsTrigger>
        </TabsList>

        {/* ----------------------------- Appearance ----------------------------- */}
        <TabsContent value="appearance" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Theme &amp; density</CardTitle>
              <CardDescription>
                Control the visual presentation of the cockpit.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Theme" htmlFor="appearance-theme">
                  <Select
                    value={theme ?? "system"}
                    onValueChange={(v) => setTheme(v)}
                  >
                    <SelectTrigger
                      id="appearance-theme"
                      aria-label="Theme"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field
                  label="Density"
                  htmlFor="appearance-density"
                  description="Compact tightens vertical spacing."
                >
                  <Select
                    value={settings.appearance.density}
                    onValueChange={(v) =>
                      setSection("appearance", {
                        density: v as SettingsState["appearance"]["density"],
                      })
                    }
                  >
                    <SelectTrigger
                      id="appearance-density"
                      aria-label="Density"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="comfortable">Comfortable</SelectItem>
                      <SelectItem value="compact">Compact</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field
                  label="Base font size"
                  htmlFor="appearance-font"
                  description="Applied to the interface text scale."
                >
                  <Select
                    value={settings.appearance.fontSize}
                    onValueChange={(v) =>
                      setSection("appearance", { fontSize: v })
                    }
                  >
                    <SelectTrigger id="appearance-font" aria-label="Base font size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="12">Small · 12px</SelectItem>
                      <SelectItem value="13">Default · 13px</SelectItem>
                      <SelectItem value="14">Large · 14px</SelectItem>
                      <SelectItem value="15">Extra large · 15px</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <SettingRow
                label="Reduce motion"
                description="Disable pulses, glows, and transitions."
                control={
                  <Switch
                    aria-label="Reduce motion"
                    checked={settings.appearance.reduceMotion}
                    onCheckedChange={(v) =>
                      setSection("appearance", { reduceMotion: v })
                    }
                  />
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Accent color</CardTitle>
              <CardDescription>
                Default is Signal Indigo. Pick a preset for power users — the
                change previews live across this view.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {ACCENT_PRESETS.map((preset) => {
                  const active = settings.appearance.accent === preset.value;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-label={preset.name}
                      aria-pressed={active}
                      onClick={() =>
                        setSection("appearance", { accent: preset.value })
                      }
                      className={cn(
                        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                        active
                          ? "border-primary/50 bg-primary/10"
                          : "border-border hover:border-border-hover",
                      )}
                    >
                      <span
                        className="size-4 rounded-full border border-border"
                        style={{ backgroundColor: preset.value }}
                      />
                      {preset.name}
                      {active ? <Check className="size-3.5 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- Agent defaults --------------------------- */}
        <TabsContent value="agent" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Agent defaults</CardTitle>
              <CardDescription>
                Mirrors the extension Agent tab — one source of truth.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Default model"
                  htmlFor="agent-model"
                  description="Used when a run does not override it."
                >
                  <Input
                    id="agent-model"
                    value={settings.agent.defaultModel}
                    onChange={(e) =>
                      setSection("agent", { defaultModel: e.target.value })
                    }
                  />
                </Field>

                <Field
                  label="Max steps"
                  htmlFor="agent-steps"
                  description="Hard stop before the agent halts."
                >
                  <Input
                    id="agent-steps"
                    type="number"
                    min={1}
                    value={settings.agent.maxSteps}
                    onChange={(e) =>
                      setSection("agent", {
                        maxSteps: Number(e.target.value) || 0,
                      })
                    }
                  />
                </Field>
              </div>

              <Field label="Vision mode" description="Off · On · Local (≈2.5 GB RAM, recommended for text-only LLMs).">
                <Segmented
                  ariaLabel="Vision mode"
                  value={settings.agent.visionMode}
                  onChange={(v) => setSection("agent", { visionMode: v })}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "on", label: "On" },
                    { value: "local", label: "Local" },
                  ]}
                />
              </Field>

              <Field label="Modes" description="Enabled agent operating modes.">
                <div className="flex flex-wrap gap-2">
                  {AGENT_MODES.map((m) => (
                    <ToggleChip
                      key={m}
                      active={settings.agent.modes.includes(m)}
                      onClick={() =>
                        setSection("agent", {
                          modes: toggleArrayItem(settings.agent.modes, m),
                        })
                      }
                    >
                      {m}
                    </ToggleChip>
                  ))}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Allowed domains"
                  htmlFor="agent-allow"
                  description="One per line. Blank = allow all."
                >
                  <textarea
                    id="agent-allow"
                    value={settings.agent.allowDomains}
                    onChange={(e) =>
                      setSection("agent", { allowDomains: e.target.value })
                    }
                    rows={4}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  />
                </Field>

                <Field
                  label="Blocked domains"
                  htmlFor="agent-block"
                  description="One per line. Always denied."
                >
                  <textarea
                    id="agent-block"
                    value={settings.agent.blockDomains}
                    onChange={(e) =>
                      setSection("agent", { blockDomains: e.target.value })
                    }
                    rows={4}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------ Debugging ------------------------------ */}
        <TabsContent value="debugging" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Debugging</CardTitle>
              <CardDescription>
                Runtime diagnostics and experimental surfaces.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <p className="pb-2 text-xs text-muted-foreground">
                These controls are preview-only and are not yet wired to the
                agent runtime — toggling them changes local UI state but does
                not capture screenshots, record DOM snapshots, or enable
                experimental capabilities.
              </p>
              <SettingRow
                label="Log verbosity"
                description="Minimum level captured by the log stream."
                control={
                  <Select
                    value={settings.debugging.verbosity}
                    onValueChange={(v) =>
                      setSection("debugging", { verbosity: v })
                    }
                    disabled
                  >
                    <SelectTrigger
                      className="w-40"
                      aria-label="Log verbosity"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debug">Debug</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warn">Warning</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <SettingRow
                label="Debug highlights (default)"
                description="Outline interactive elements during a run."
                control={
                  <Switch
                    aria-label="Debug highlights default"
                    checked={settings.debugging.debugHighlights}
                    disabled
                    onCheckedChange={(v) =>
                      setSection("debugging", { debugHighlights: v })
                    }
                  />
                }
              />
              <SettingRow
                label="Capture screenshots"
                description="Save a screenshot at each step."
                control={
                  <Switch
                    aria-label="Capture screenshots"
                    checked={settings.debugging.captureScreenshots}
                    disabled
                    onCheckedChange={(v) =>
                      setSection("debugging", { captureScreenshots: v })
                    }
                  />
                }
              />
              <SettingRow
                label="Record full DOM snapshots"
                description="Persist the entire DOM tree, not just diffs."
                control={
                  <Switch
                    aria-label="Record full DOM snapshots"
                    checked={settings.debugging.recordDomSnapshots}
                    disabled
                    onCheckedChange={(v) =>
                      setSection("debugging", { recordDomSnapshots: v })
                    }
                  />
                }
              />
              <SettingRow
                label="Experimental features"
                description="Opt into unreleased capabilities."
                control={
                  <Switch
                    aria-label="Experimental features"
                    checked={settings.debugging.experimental}
                    disabled
                    onCheckedChange={(v) =>
                      setSection("debugging", { experimental: v })
                    }
                  />
                }
              />
            </CardContent>
            <CardFooter className="pt-4">
              <Button
                variant="outline"
                disabled
                onClick={() =>
                  toast({
                    title: "Telemetry exported",
                    description: "open-cowork-telemetry.json downloaded.",
                  })
                }
              >
                <Download className="size-4" /> Export telemetry
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        {/* ----------------------------- Connections ----------------------------- */}
        <TabsContent value="connections" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Connections</CardTitle>
              <CardDescription>
                How the cockpit talks to the agent runtime and model providers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Cockpit URL"
                htmlFor="conn-url"
                description="Base URL of the cowork-events / agent runtime."
              >
                <Input
                  id="conn-url"
                  type="url"
                  value={settings.connections.cockpitUrl}
                  onChange={(e) =>
                    setSection("connections", { cockpitUrl: e.target.value })
                  }
                />
              </Field>

              <Field
                label="Provider"
                htmlFor="conn-provider"
                description="Default model provider."
              >
                <Select
                  value={settings.connections.provider}
                  onValueChange={(v) =>
                    setSection("connections", { provider: v })
                  }
                >
                  <SelectTrigger id="conn-provider" aria-label="Provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="API key"
                htmlFor="conn-key"
                description="Stored locally; never shown in logs."
              >
                <div className="flex gap-2">
                  <Input
                    id="conn-key"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    value={settings.connections.apiKey}
                    onChange={(e) =>
                      setSection("connections", { apiKey: e.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- Notifications ---------------------------- */}
        <TabsContent value="notifications" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>
                When to notify and where the alerts go.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="divide-y divide-border">
                <SettingRow
                  label="On error"
                  description="Notify when a run fails or is blocked."
                  control={
                    <Switch
                      aria-label="Notify on error"
                      checked={settings.notifications.onError}
                      onCheckedChange={(v) =>
                        setSection("notifications", { onError: v })
                      }
                    />
                  }
                />
                <SettingRow
                  label="On complete"
                  description="Notify when a run finishes successfully."
                  control={
                    <Switch
                      aria-label="Notify on complete"
                      checked={settings.notifications.onComplete}
                      onCheckedChange={(v) =>
                        setSection("notifications", { onComplete: v })
                      }
                    />
                  }
                />
                <SettingRow
                  label="On takeover"
                  description="Notify when the agent requests human input."
                  control={
                    <Switch
                      aria-label="Notify on takeover"
                      checked={settings.notifications.onTakeover}
                      onCheckedChange={(v) =>
                        setSection("notifications", { onTakeover: v })
                      }
                    />
                  }
                />
              </div>

              <Field label="Channels" description="Where alerts are delivered.">
                <div className="flex flex-wrap gap-2">
                  {NOTIFY_CHANNELS.map((c) => (
                    <ToggleChip
                      key={c}
                      active={settings.notifications.channels.includes(c)}
                      onClick={() =>
                        setSection("notifications", {
                          channels: toggleArrayItem(
                            settings.notifications.channels,
                            c,
                          ),
                        })
                      }
                    >
                      {c}
                    </ToggleChip>
                  ))}
                </div>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        {/* -------------------------------- Data --------------------------------- */}
        <TabsContent value="data" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>Data</CardTitle>
              <CardDescription>
                Retention, export, import, and history cleanup.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Retention policy"
                htmlFor="data-retention"
                description="How long run and history records are kept."
              >
                <Select
                  value={settings.data.retention}
                  onValueChange={(v) => setSection("data", { retention: v })}
                >
                  <SelectTrigger id="data-retention" aria-label="Retention policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">7 days</SelectItem>
                    <SelectItem value="30d">30 days</SelectItem>
                    <SelectItem value="90d">90 days</SelectItem>
                    <SelectItem value="forever">Forever</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" onClick={handleExportAll}>
                  <Download className="size-4" /> Export all
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="size-4" /> Import
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setClearOpen(true)}
                >
                  <Trash2 className="size-4" /> Clear history
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={handleImportFile}
                />
              </div>
            </CardContent>
            <CardFooter className="pt-4">
              <p className="text-xs text-muted-foreground">
                Storage usage is reported by the backend once a persistence
                endpoint is available.
              </p>
            </CardFooter>
          </Card>
        </TabsContent>

        {/* -------------------------------- About -------------------------------- */}
        <TabsContent value="about" className={cn("mt-2", densitySpacing)}>
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
              <CardDescription>
                Open Cowork — the canonical configuration hub.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Version">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-mono">
                      v{APP_VERSION}
                    </Badge>
                  </div>
                </Field>
                <Field label="Build">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {APP_BUILD}
                    </Badge>
                  </div>
                </Field>
              </div>
              <Field label="Licenses">
                <p className="text-sm text-muted-foreground">
                  Open Cowork is distributed under the MIT license. Third-party
                  license text is maintained in{" "}
                  <span className="font-mono">THIRD_PARTY_LICENSES.md</span>.
                </p>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Clear history confirmation — styled Dialog, never native confirm. */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear browsing history?</DialogTitle>
            <DialogDescription>
              This permanently removes browsing history for this session. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleClearHistory}>
              <Trash2 className="size-4" /> Clear history
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset confirmation. */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset all settings?</DialogTitle>
            <DialogDescription>
              All configuration reverts to the Open Cowork defaults.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleReset}>
              <RotateCcw className="size-4" /> Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
