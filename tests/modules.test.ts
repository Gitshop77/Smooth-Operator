/**
 * Tests for the supporting modules: callbacks, judge, domain-skills, modes, errors.
 */

import { describe, test, expect } from "vitest";
import {
  CallbackDispatcher,
} from "../src/lib/agent/callbacks";
import { getDomainSkills, getSkillFrontmatter, getFullSkill } from "../src/lib/agent/domain-skills";
import { checkActionAllowed, MODE_CONFIGS, requiresConfirmation } from "../src/lib/agent/modes";
import { ACTION_METADATA } from "../src/lib/agent/tools/schema";

// ─── Callbacks ───────────────────────────────────────────────────────────────

describe("CallbackDispatcher", () => {
  test("runs registered callbacks in order", async () => {
    const calls: string[] = [];
    const dispatcher = new CallbackDispatcher();
    dispatcher.register({
      onRunStart: () => { calls.push("handler1-start"); },
      onRunEnd: () => { calls.push("handler1-end"); },
    });
    dispatcher.register({
      onRunStart: () => { calls.push("handler2-start"); },
      onRunEnd: () => { calls.push("handler2-end"); },
    });
    await dispatcher.runStart({ task: "test", step: 0, history: [] });
    await dispatcher.runEnd({ success: true, text: "done", stepCount: 1, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0 });
    expect(calls).toEqual(["handler1-start", "handler2-start", "handler1-end", "handler2-end"]);
  });

  test("handles missing hooks gracefully", async () => {
    const dispatcher = new CallbackDispatcher();
    dispatcher.register({}); // no hooks
    await expect(dispatcher.runStart({ task: "test", step: 0, history: [] })).resolves.toBeUndefined();
  });

  test("clear() removes all handlers", async () => {
    const calls: string[] = [];
    const dispatcher = new CallbackDispatcher();
    dispatcher.register({ onRunStart: () => { calls.push("called"); } });
    dispatcher.clear();
    await dispatcher.runStart({ task: "test", step: 0, history: [] });
    expect(calls).toEqual([]);
  });

  test("awaits async handlers in order", async () => {
    const calls: string[] = [];
    const dispatcher = new CallbackDispatcher();
    dispatcher.register({
      onRunStart: async () => {
        await new Promise((r) => setTimeout(r, 10));
        calls.push("slow");
      },
    });
    dispatcher.register({
      onRunStart: () => { calls.push("fast"); },
    });
    await dispatcher.runStart({ task: "test", step: 0, history: [] });
    expect(calls).toEqual(["slow", "fast"]);
  });
});

// ─── Domain skills ───────────────────────────────────────────────────────────

describe("getDomainSkills", () => {
  test("matches GitHub", async () => {
    const skills = await getDomainSkills("https://github.com/owner/repo");
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0].name).toBe("GitHub");
  });

  test("matches subdomains", async () => {
    const skills = await getDomainSkills("https://gist.github.com/user");
    expect(skills.some((s) => s.name === "GitHub")).toBe(true);
  });

  test("matches Gmail", async () => {
    const skills = await getDomainSkills("https://mail.google.com/mail");
    expect(skills.some((s) => s.name === "Gmail")).toBe(true);
  });

  test("matches Amazon", async () => {
    const skills = await getDomainSkills("https://www.amazon.com/dp/B123");
    expect(skills.some((s) => s.name === "Amazon")).toBe(true);
  });

  test("returns empty for unknown domains", async () => {
    const skills = await getDomainSkills("https://random-unknown-site.com");
    expect(skills.length).toBe(0);
  });

  test("returns empty for invalid URLs", async () => {
    expect((await getDomainSkills("not-a-url")).length).toBe(0);
  });

  test("returns empty for empty string", async () => {
    expect((await getDomainSkills("")).length).toBe(0);
  });

  test("matches Google Search on google.com", async () => {
    const skills = await getDomainSkills("https://google.com/search?q=test");
    expect(skills.some((s) => s.name === "Google Search")).toBe(true);
  });

  test("does not match lookalike domains", async () => {
    expect((await getDomainSkills("https://notgithub.com")).length).toBe(0);
    expect((await getDomainSkills("https://github.com.evil.com")).length).toBe(0);
  });
});

// ─── Frontmatter-first skill loading ────────────────────────────────────────

describe("getSkillFrontmatter", () => {
  test("returns name + frontmatter for matching skills (lightweight)", async () => {
    const fm = await getSkillFrontmatter("https://github.com/owner/repo");
    expect(fm.length).toBeGreaterThan(0);
    expect(fm[0].name).toBe("GitHub");
 // The description is the frontmatter string — one sentence, no full body.
    expect(fm[0].description).toContain("Tips for");
    expect(fm[0].description.length).toBeLessThan(120);
  });

  test("returns [] for unknown domains", async () => {
    expect(await getSkillFrontmatter("https://random-unknown-site.com")).toEqual([]);
  });

  test("returns [] for invalid URLs", async () => {
    expect(await getSkillFrontmatter("not-a-url")).toEqual([]);
    expect(await getSkillFrontmatter("")).toEqual([]);
  });

  test("de-duplicates by name (twitter.com + x.com both match)", async () => {
 // https://x.com/foo matches both twitter.com (no) and x.com (yes) skills,
 // both named "Twitter/X". The frontmatter list should contain "Twitter/X"
 // exactly once.
    const fm = await getSkillFrontmatter("https://x.com/foo");
    const twitterCount = fm.filter((s) => s.name === "Twitter/X").length;
    expect(twitterCount).toBe(1);
  });

  test("frontmatter is much shorter than the full instructions", async () => {
 // Sanity check: the frontmatter (always in context) is dramatically
 // smaller than the full skill body (loaded on demand) — this is the
 // whole point of the frontmatter-first model.
    const fm = await getSkillFrontmatter("https://github.com/test");
    const full = await getFullSkill("GitHub");
    expect(fm[0].description.length).toBeLessThan(full.length / 4);
  });
});

describe("getFullSkill", () => {
  test("returns the full instruction body for a known skill", async () => {
    const body = await getFullSkill("GitHub");
    expect(body).toContain("GitHub tips:");
    expect(body).toContain("Issues");
 // Includes dangerous-actions appendix.
    expect(body).toContain("Dangerous actions");
 // Includes shortcuts appendix.
    expect(body).toContain("Shortcuts:");
  });

  test("returns the full body for every built-in skill", async () => {
    const names = ["GitHub", "Gmail", "Amazon", "Google Search", "Twitter/X", "LinkedIn", "Reddit"];
    for (const name of names) {
      const body = await getFullSkill(name);
      expect(body.length).toBeGreaterThan(50);
      expect(body).toContain("tips:");
    }
  });

  test("returns '' for an unknown skill name", async () => {
    expect(await getFullSkill("NotARealSkill")).toBe("");
  });

  test("returns '' for an empty name", async () => {
    expect(await getFullSkill("")).toBe("");
  });
});

// ─── Modes ───────────────────────────────────────────────────────────────────

describe("Mode enforcement", () => {
  test("restricted blocks navigate + evaluate + tabs", () => {
    expect(checkActionAllowed("navigate", "restricted").allowed).toBe(false);
    expect(checkActionAllowed("evaluate", "restricted").allowed).toBe(false);
    expect(checkActionAllowed("switch_tab", "restricted").allowed).toBe(false);
    expect(checkActionAllowed("close_tab", "restricted").allowed).toBe(false);
  });

  test("standard allows navigate but blocks evaluate", () => {
    expect(checkActionAllowed("navigate", "standard").allowed).toBe(true);
    expect(checkActionAllowed("evaluate", "standard").allowed).toBe(false);
  });

  test("full_agentic allows every action in ACTION_METADATA", () => {
 // Iterate over ACTION_METADATA keys so this test stays in sync when
 // actions are added — no hardcoded list to maintain.
    const allActions = Object.keys(ACTION_METADATA);
    for (const action of allActions) {
      expect(checkActionAllowed(action, "full_agentic").allowed).toBe(true);
    }
  });

  test("max steps differ by mode", () => {
    expect(MODE_CONFIGS.restricted.maxSteps).toBe(30);
    expect(MODE_CONFIGS.standard.maxSteps).toBe(100);
    expect(MODE_CONFIGS.full_agentic.maxSteps).toBe(500);
  });

  test("requires confirmation for evaluate in standard mode", () => {
    expect(requiresConfirmation("evaluate", "standard")).toBe(true);
    expect(requiresConfirmation("evaluate", "full_agentic")).toBe(false);
  });

  test("restricted mode has the fewest permissions", () => {
    const r = MODE_CONFIGS.restricted;
    expect(r.canNavigate).toBe(false);
    expect(r.canOpenTabs).toBe(false);
    expect(r.canExecuteJs).toBe(false);
  });

  test("full_agentic mode has the most permissions", () => {
    const f = MODE_CONFIGS.full_agentic;
 // All 7 capability flags must be true in full_agentic mode.
    expect(f.canNavigate).toBe(true);
    expect(f.canOpenTabs).toBe(true);
    expect(f.canExecuteJs).toBe(true);
    expect(f.canUploadFiles).toBe(true);
    expect(f.canCloseTabs).toBe(true);
    expect(f.canSwitchTabs).toBe(true);
    expect(f.canDownloadFiles).toBe(true);
  });
});

