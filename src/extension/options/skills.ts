/**
 * options/skills.ts — A7 custom domain skills.
 *
 * User-defined Markdown skills (per-domain instructions) stored under
 * `open_cowork_custom_skills` in chrome.storage.local. Rendered as a list
 * with delete buttons; new skills are added via the form on the Skills tab.
 */

import { $, escapeHtml } from "@/extension/shared";

const CUSTOM_SKILLS_KEY = "open_cowork_custom_skills";

async function readCustomSkills(): Promise<Array<{ domains: string[]; name: string; frontmatter: string; instructions: string }>> {
  const res = await chrome.storage.local.get(CUSTOM_SKILLS_KEY);
  return (res[CUSTOM_SKILLS_KEY] as Array<{ domains: string[]; name: string; frontmatter: string; instructions: string }>) || [];
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
  for (const s of skills) {
    const item = document.createElement("div");
    item.className = "secret-item";
    item.innerHTML =
      `<span class="name">${escapeHtml(s.name)} (${escapeHtml(s.domains.join(", "))})</span>` +
      `<button type="button">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", async () => {
      const filtered = skills.filter((x) => x.name !== s.name);
      await chrome.storage.local.set({ [CUSTOM_SKILLS_KEY]: filtered });
      await renderSkills();
    });
    list.appendChild(item);
  }
}

$("addSkill")?.addEventListener("click", async () => {
  const domain = ($("skillDomain") as HTMLInputElement).value.trim();
  const name = ($("skillName") as HTMLInputElement).value.trim();
  const instructions = ($("skillInstructions") as HTMLTextAreaElement).value.trim();
  if (!domain || !name || !instructions) return;
  const skills = await readCustomSkills();
  skills.push({ domains: [domain], name, frontmatter: instructions.split("\n")[0].slice(0, 100), instructions });
  await chrome.storage.local.set({ [CUSTOM_SKILLS_KEY]: skills });
  ($("skillDomain") as HTMLInputElement).value = "";
  ($("skillName") as HTMLInputElement).value = "";
  ($("skillInstructions") as HTMLTextAreaElement).value = "";
  await renderSkills();
});
