/**
 * options/skills.ts — custom domain skills.
 *
 * User-defined Markdown skills (per-domain instructions) stored under
 * `open_cowork_custom_skills` in chrome.storage.local. Rendered with their OWN
 * `.skill-item` markup (no longer reusing `.secret-item`).
 *
 * NOTE: the persisted `frontmatter` field IS consumed by the agent runtime
 * (`src/lib/agent/domain-skills.ts` -> `getSkillFrontmatter`, which surfaces it
 * to the navigator as the skill's one-line description). It is not rendered
 * here, but it must stay in the stored shape, so it is intentionally retained.
 */

import { $, escapeHtml } from "@/extension/shared";
import { showSaved } from "./settings-sync";
import { alertModal } from "./modal";

const CUSTOM_SKILLS_KEY = "open_cowork_custom_skills";

interface CustomSkill {
  domains: string[];
  name: string;
  frontmatter: string;
  instructions: string;
}

// ─── Field constraints ───────────────────────────────────────────────────────
const NAME_MAX = 64;
const DOMAIN_MAX = 100;
const INSTRUCTIONS_MAX = 50_000;
// Human-readable skill names (e.g. "GitHub") — keep them to a single line and
// within a sane length rather than forcing the strict tool-name regex.
const NAME_RE = /^[^\n\r\t]{1,64}$/;

/**
 * True if `value` is a bare hostname (optionally a `*.` wildcard prefix), with
 * no scheme, path, port, or space. Mirrors the validation applied to
 * `allowedDomains` / `blockedDomains` in `settings-sync.ts` so skill domains
 * match the same contract the domain-skills matcher relies on.
 */
function isBareHostname(value: string): boolean {
  if (!value || value.includes("/") || value.includes(" ") || value.includes(":")) return false;
  const candidate = value.startsWith("*.") ? value.slice(2) : value;
  if (!candidate) return false;
  try {
    const u = new URL("http://" + candidate);
    // URL lower-cases the hostname; compare lowercased so legitimate UPPERCASE
    // / IDN hostnames aren't silently rejected.
    return u.hostname.toLowerCase() === candidate.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Mutation serialization ──────────────────────────────────────────────────
let mutationQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Defensive storage parsing ───────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateCustomSkills(raw: unknown): CustomSkill[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn("[skills] stored custom-skills value is not an array; ignoring.", raw);
    return [];
  }
  const out: CustomSkill[] = [];
  raw.forEach((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.instructions !== "string" ||
      !Array.isArray(entry.domains) ||
      !entry.domains.every((d) => typeof d === "string")
    ) {
      console.warn(`[skills] dropping malformed custom skill at index ${i}.`, entry);
      return;
    }
    // `frontmatter` is optional in storage (older entries may lack it); derive
    // it when missing so the runtime keeps getting a one-line description.
    const frontmatter =
      typeof entry.frontmatter === "string"
        ? entry.frontmatter
        : entry.instructions.split("\n")[0].slice(0, 100);
    out.push({
      domains: entry.domains,
      name: entry.name,
      frontmatter,
      instructions: entry.instructions,
    });
  });
  return out;
}

async function readCustomSkills(): Promise<CustomSkill[]> {
  const res = await chrome.storage.local.get(CUSTOM_SKILLS_KEY);
  return validateCustomSkills(res[CUSTOM_SKILLS_KEY]);
}

/** Render the custom skills list. Call after every mutation. */
export async function renderSkills(): Promise<void> {
  const skills = await readCustomSkills();
  const list = $("skillsList") as HTMLDivElement;
  list.innerHTML = "";
  if (skills.length === 0) {
    list.innerHTML = '<p class="empty-hint">No custom skills defined. Add one above.</p>';
    return;
  }
  skills.forEach((s, index) => {
    const item = document.createElement("div");
    item.className = "skill-item";
    item.innerHTML =
      `<div class="skill-meta">` +
        `<span class="skill-name">${escapeHtml(s.name)}</span>` +
        `<span class="skill-domains">${escapeHtml(s.domains.join(", "))}</span>` +
      `</div>` +
      `<pre class="skill-instructions">${escapeHtml(s.instructions)}</pre>` +
      `<button type="button" class="skill-delete">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", () => {
      void serialize(async () => {
        const filtered = skills.filter((_, i) => i !== index);
        await chrome.storage.local.set({ [CUSTOM_SKILLS_KEY]: filtered });
        await renderSkills();
        showSaved();
      });
    });
    list.appendChild(item);
  });
}

$("addSkill")?.addEventListener("click", () => {
  void serialize(async () => {
    const domain = ($("skillDomain") as HTMLInputElement).value.trim();
    const name = ($("skillName") as HTMLInputElement).value.trim();
    const instructions = ($("skillInstructions") as HTMLTextAreaElement).value.trim();
    if (!domain || !name || !instructions) return;
    if (!NAME_RE.test(name)) {
      await alertModal({
        title: "Invalid skill name",
        message: "Skill name must be a single line of at most 64 characters.",
      });
      return;
    }
    if (!isBareHostname(domain)) {
      await alertModal({
        title: "Invalid skill domain",
        message:
          "Skill domain must be a bare hostname (e.g. example.com), optionally " +
          "with a *. wildcard. No scheme (http://), path, or port is allowed.",
      });
      return;
    }
    if (domain.length > DOMAIN_MAX) {
      await alertModal({
        title: "Domain too long",
        message: `Skill domain must be at most ${DOMAIN_MAX} characters.`,
      });
      return;
    }
    if (instructions.length > INSTRUCTIONS_MAX) {
      await alertModal({
        title: "Instructions too long",
        message: `Skill instructions must be at most ${INSTRUCTIONS_MAX} characters.`,
      });
      return;
    }
    const skills = await readCustomSkills();
    // Enforce name uniqueness: overwrite the existing entry instead of adding a
    // second one, so delete-by-name (and delete-by-index) stays safe.
    const idx = skills.findIndex((s) => s.name === name);
    const frontmatter = instructions.split("\n")[0].slice(0, 100);
    // When updating an existing skill, preserve its other domains and merge in
    // the newly-entered one — re-adding by name must not silently discard a
    // multi-domain entry (e.g. re-adding "github.com" used to wipe the other
    // domains the skill was already configured for).
    let domains: string[];
    if (idx >= 0) {
      const existing = skills[idx].domains;
      domains = existing.includes(domain) ? existing : [...existing, domain];
    } else {
      domains = [domain];
    }
    const entry: CustomSkill = { domains, name, frontmatter, instructions };
    if (idx >= 0) skills[idx] = entry;
    else skills.push(entry);
    await chrome.storage.local.set({ [CUSTOM_SKILLS_KEY]: skills });
    ($("skillDomain") as HTMLInputElement).value = "";
    ($("skillName") as HTMLInputElement).value = "";
    ($("skillInstructions") as HTMLTextAreaElement).value = "";
    await renderSkills();
    showSaved();
  });
});
