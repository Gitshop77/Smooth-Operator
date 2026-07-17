import { describe, it, expect } from "vitest";
import {
  type SettingsState,
  ENUM_VALUES,
  HEX_COLOR,
  coerceBool,
  clampMaxSteps,
  sanitizeSection,
  mergeSettings,
} from "@/lib/cowork/settings-sanitize";

const BASE: SettingsState = {
  appearance: {
    theme: "system",
    accent: "#6C5CE7",
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

describe("coerceBool", () => {
  it("parses string and boolean forms", () => {
    expect(coerceBool("true")).toBe(true);
    expect(coerceBool("FALSE")).toBe(false);
    expect(coerceBool(true)).toBe(true);
    expect(coerceBool(false)).toBe(false);
    expect(coerceBool(1)).toBe(true);
    expect(coerceBool(0)).toBe(false);
  });
});

describe("clampMaxSteps", () => {
  it("clamps out-of-range and non-finite values", () => {
    expect(clampMaxSteps(0)).toBe(1);
    expect(clampMaxSteps(-5)).toBe(1);
    expect(clampMaxSteps(1_000_000)).toBe(100_000);
    expect(clampMaxSteps(50.9)).toBe(50);
    expect(clampMaxSteps(100)).toBe(100);
  });
});

describe("sanitizeSection", () => {
  it("falls back to base for an invalid enum value", () => {
    const out = sanitizeSection(
      "appearance",
      BASE.appearance,
      { density: "weird" } as unknown as Partial<SettingsState["appearance"]>,
    );
    expect(out.density).toBe("comfortable");
  });

  it("keeps a valid enum value", () => {
    const out = sanitizeSection("appearance", BASE.appearance, {
      density: "compact",
    });
    expect(out.density).toBe("compact");
  });

  it("rejects a non-hex accent and keeps the base", () => {
    const out = sanitizeSection("appearance", BASE.appearance, {
      accent: "not-a-color",
    });
    expect(out.accent).toBe("#6C5CE7");
    expect(HEX_COLOR.test(out.accent)).toBe(true);
  });

  it("truncates apiKey to 512 chars", () => {
    const longKey = "k".repeat(800);
    const out = sanitizeSection("connections", BASE.connections, {
      apiKey: longKey,
    });
    expect(out.apiKey.length).toBe(512);
    expect(out.apiKey).toBe("k".repeat(512));
  });

  it("clamps maxSteps out of range", () => {
    const out = sanitizeSection("agent", BASE.agent, { maxSteps: 999999 });
    expect(out.maxSteps).toBe(100_000);
    const out2 = sanitizeSection("agent", BASE.agent, { maxSteps: 0 });
    expect(out2.maxSteps).toBe(1);
  });

  it("drops unknown keys and ignores array-shaped sections", () => {
    const out = sanitizeSection(
      "appearance",
      BASE.appearance,
      {
        theme: "dark",
        evil: "x",
      } as unknown as Partial<SettingsState["appearance"]>,
    );
    expect(out.theme).toBe("dark");
    expect((out as unknown as Record<string, unknown>).evil).toBeUndefined();
  });

  it("returns base when incoming is not a plain object", () => {
    expect(sanitizeSection("agent", BASE.agent, undefined)).toEqual(BASE.agent);
    expect(
      sanitizeSection(
        "agent",
        BASE.agent,
        [] as unknown as Partial<SettingsState["agent"]>,
      ),
    ).toEqual(BASE.agent);
  });

  it("array fields only accept string members", () => {
    const out = sanitizeSection("agent", BASE.agent, {
      modes: ["Standard", 123, "Full agentic"] as unknown as string[],
    });
    expect(out.modes).toEqual(["Standard", "Full agentic"]);
  });
});

describe("mergeSettings", () => {
  it("merges multiple sanitized sections without leaking unknown keys", () => {
    const merged = mergeSettings(BASE, {
      appearance: { accent: "bogus", fontSize: "14" },
      connections: { apiKey: "a".repeat(600), provider: "nope" },
      data: { retention: "90d" },
      bogusSection: { x: 1 },
    } as unknown as Partial<SettingsState>);
    expect(merged.appearance.accent).toBe("#6C5CE7");
    expect(merged.appearance.fontSize).toBe("14");
    expect(merged.connections.apiKey.length).toBe(512);
    expect(merged.connections.provider).toBe("anthropic");
    expect(merged.data.retention).toBe("90d");
    expect(
      (merged as unknown as Record<string, unknown>).bogusSection,
    ).toBeUndefined();
  });

  it("keeps enum sets exhaustive", () => {
    expect(ENUM_VALUES["connections.provider"].length).toBe(16);
  });
});
