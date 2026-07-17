/* -------------------------------------------------------------------------- */
/* Untrusted settings-import sanitization                                      */
/*                                                                            */
/* Pure, framework-free boundary for importing settings from an arbitrary     */
/* JSON file. Kept out of the React view so it can be unit-tested and so a    */
/* regression in the import-validation guard cannot ship silently.            */
/* -------------------------------------------------------------------------- */

export interface SettingsState {
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

/* Allowed values for enum-style settings. Imported values are constrained to
 * these sets so a malformed/erroneous file cannot desync the UI (e.g. a blank
 * Select) or set a semantically invalid state that a future consumer trusts. */
export const ENUM_VALUES: Record<string, readonly string[]> = {
  "appearance.density": ["comfortable", "compact"],
  "appearance.fontSize": ["12", "13", "14", "15"],
  "agent.visionMode": ["off", "on", "local"],
  "connections.provider": [
    "openai",
    "anthropic",
    "gemini",
    "google",
    "deepseek",
    "groq",
    "together",
    "mistral",
    "cerebras",
    "openrouter",
    "xai",
    "ollama",
    "qwen",
    "opencode",
    "litellm",
    "azure",
  ],
  "data.retention": ["7d", "30d", "90d", "forever"],
  "debugging.verbosity": ["debug", "info", "warn", "error"],
};

export const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Coerce an unknown import value to a boolean, matching the prior inline rule. */
export function coerceBool(v: unknown): boolean {
  const s = typeof v === "string" ? v.toLowerCase() : v;
  if (s === true || s === "true") return true;
  if (s === false || s === "false") return false;
  return Boolean(v);
}

/** Clamp the max-steps setting to a finite positive integer (1..100000). */
export const clampMaxSteps = (n: number) =>
  Math.min(Math.max(Math.trunc(n), 1), 100000);

/* Sanitize one section of an *untrusted* import: only known keys (whitelisted
 * via the SettingsState shape) are carried over, values are coerced to the
 * expected type, enumerated fields are restricted to known-good values,
 * `maxSteps` is clamped to a sane positive range, and `accent` must be a hex
 * color before it can reach the `--primary` CSS custom property. Invalid or
 * missing values fall back to the existing (current) value. */
export function sanitizeSection<K extends keyof SettingsState>(
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
      out[key] = enumSet.includes(String(value)) ? value : fallback[key];
      continue;
    }

    const ref = fallback[key];
    if (typeof ref === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = key === "maxSteps" ? clampMaxSteps(n) : n;
    } else if (typeof ref === "boolean") {
      out[key] = coerceBool(value);
    } else if (typeof ref === "string") {
      const s = String(value);
      out[key] =
        key === "accent" && !HEX_COLOR.test(s)
          ? ref
          : key === "apiKey"
            ? s.slice(0, 512)
            : s;
    } else if (Array.isArray(ref)) {
      out[key] = Array.isArray(value)
        ? value.filter((x) => typeof x === "string")
        : ref;
    }
  }
  return out as SettingsState[K];
}

export function mergeSettings(
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
