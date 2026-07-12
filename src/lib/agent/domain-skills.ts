/**
 * Domain skills — per-site instruction packs that make the agent smarter on
 * specific websites.
 *
 * When the agent visits a site, matching skills are injected as
 * `<system-reminder>` blocks. Skills contain site-specific tips, shortcuts,
 * known-dangerous actions, and navigation patterns.
 *
 * Built-in skills: GitHub, Gmail, Amazon, Google Search, Twitter/X, LinkedIn,
 * Reddit. Users can add custom skills via chrome.storage.
 */

import { isExtensionWithLocal } from "./runtime";

/** Definition of a per-site instruction pack. */
export interface DomainSkill {
  /** Root domains to match (e.g. ["github.com"] or ["twitter.com", "x.com"]).
 * Changed from a single string to an array so multi-domain sites
 * (Twitter/X) don't require duplicate skill objects. */
  domains: string[];
  /** Human-readable site name (used in the prompt header). */
  name: string;
  /** Short description shown in the navigator's <available_skills> block (always in context). */
  frontmatter: string;
  /** Full instructions loaded on-demand via the load_skill action. */
  instructions: string;
  /** Actions that should require explicit user confirmation on this site. */
  dangerousActions?: string[];
  /** Quick-reference shortcuts (label → how-to). */
  shortcuts?: Record<string, string>;
}

/** Built-in skills for the 7 most common automation targets. */
export const BUILT_IN_SKILLS: readonly DomainSkill[] = [
  {
    domains: ["github.com"],
    name: "GitHub",
    frontmatter: "Tips for repos, issues, PRs, code search, branch management",
    instructions: `GitHub tips:
- To create an issue: navigate to the repo → click "Issues" tab → click "New issue"
- To search code: use the search bar at the top, or press "/" to focus it
- To switch branches: click the branch dropdown (usually says "main")
- Pull requests are in the "Pull requests" tab
- The "Code" button clones the repo — don't click it unless asked
- Markdown is used for issues, PRs, and comments
- Keyboard shortcut "g c" goes to code, "g i" goes to issues, "g p" goes to PRs`,
    dangerousActions: ["delete repository", "force push", "delete branch", "merge pull request", "close issue without comment"],
    shortcuts: {
      "create issue": "Click Issues tab → New issue",
      "create PR": "Click Pull requests tab → New pull request",
      "search code": "Press / or click search bar",
    },
  },
  {
    domains: ["mail.google.com"],
    name: "Gmail",
    frontmatter: "Tips for compose, reply, search, labels, attachments",
    instructions: `Gmail tips:
- To compose: click the "Compose" button (top-left)
- To reply: click "Reply" at the bottom of an email
- To search: use the search bar at the top, supports operators like "from:", "subject:", "has:attachment"
- To archive: click the archive icon (box with down arrow)
- To delete: click the trash icon
- Labels are on the left sidebar
- The "Send" button is blue, at the bottom of the compose window`,
    dangerousActions: ["send email", "delete all emails", "forward to external address", "change password"],
    shortcuts: {
      "compose": "Click Compose button (top-left)",
      "search": "Click search bar or press /",
      "reply": "Click Reply at bottom of email",
    },
  },
  {
    domains: ["amazon.com"],
    name: "Amazon",
    frontmatter: "Tips for search, cart, checkout, product pages, reviews",
    instructions: `Amazon tips:
- To search: use the search bar at the top
- To add to cart: click "Add to Cart" (yellow/orange button)
- To view cart: click "Cart" (top-right) or go to /cart
- To checkout: click "Proceed to checkout" (yellow button)
- Product reviews are at the bottom of the product page
- "Buy Now" skips the cart — be careful
- Prices are shown with $ and may include "Prime" badge`,
    dangerousActions: ["buy now", "proceed to checkout", "one-click buy", "change payment method", "change shipping address"],
    shortcuts: {
      "search": "Type in search bar at top",
      "add to cart": "Click Add to Cart button",
      "view cart": "Click Cart at top-right",
    },
  },
  {
    domains: ["google.com"],
    name: "Google Search",
    frontmatter: "Tips for search results, pagination, search operators",
    instructions: `Google Search tips:
- To search: type in the search box and press Enter or click "Google Search"
- Search results show title (blue link), URL (green), and snippet (gray text)
- To go to a result: click the blue title link
- To go to next page: click "Next" at the bottom
- Tabs: All, Images, News, Videos, Maps — click to switch
- "I'm Feeling Lucky" goes directly to the first result`,
    shortcuts: {
      "search": "Type in search box, press Enter",
      "next page": "Click Next at bottom",
    },
  },
  {
 // merged twitter.com + x.com into one entry with domains array
    domains: ["twitter.com", "x.com"],
    name: "Twitter/X",
    frontmatter: "Tips for posting, replying, searching, profile navigation",
    instructions: `Twitter/X tips:
- To post: click "Post" (blue button) → type → click "Post" again
- To reply: click the reply icon (speech bubble) under a tweet
- To like: click the heart icon
- To retweet: click the retweet icon (two arrows)
- The search bar is at the top-right
- Your profile is accessible by clicking your avatar
- Direct messages are in the envelope icon`,
    dangerousActions: ["post tweet", "send direct message", "delete tweet", "block user", "change account settings"],
  },
  {
    domains: ["linkedin.com"],
    name: "LinkedIn",
    frontmatter: "Tips for profile, connections, job applications, messaging",
    instructions: `LinkedIn tips:
- To search: use the search bar at the top
- To connect: click "Connect" on a profile
- To message: click "Message" on a profile
- Your profile is under "Me" (your avatar, top-right)
- Jobs are under the "Jobs" tab
- "Easy Apply" lets you apply with one click — be careful`,
    dangerousActions: ["connect with someone", "send message", "easy apply", "endorse skills", "recommend someone"],
  },
  {
    domains: ["reddit.com"],
    name: "Reddit",
    frontmatter: "Tips for subreddits, posts, comments, search",
    instructions: `Reddit tips:
- To search: use the search bar at the top
- To upvote/downvote: click the up/down arrows next to a post
- To comment: click "Add a comment" at the bottom of a post
- Subreddits are in the left sidebar
- Sort options: Hot, New, Top, Rising — at the top of the feed
- To create a post: click "Create Post" (top-right)`,
    dangerousActions: ["post to subreddit", "send private message", "delete post", "ban user (mod only)"],
  },
] as const;

/**
 * Test whether `hostname` matches `domain` (exact match or subdomain).
 */
function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Storage key under which custom skills are persisted. */
const CUSTOM_SKILLS_STORAGE_KEY = "open_cowork_custom_skills";

/**
 * Read user-defined custom domain skills from chrome.storage.local.
 * Returns an empty array in non-extension contexts (e.g. the in-page demo)
 * or when storage is unavailable. Internal helper — callers should use
 * {@link getDomainSkills} which merges built-in + custom skills.
 */
// module-level cache for custom domain skills.
let customSkillsCache: DomainSkill[] | null = null;

if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CUSTOM_SKILLS_STORAGE_KEY]) {
      customSkillsCache = null;
    }
  });
}

/**
 * Length caps for custom-skill content. Custom skills are attacker-influenced
 * data (anyone with write access to `chrome.storage.local`) that flows into the
 * TRUSTED system prompt, so unbounded content is a token-bloat / cost-DoS
 * vector. These caps bound the worst-case prompt contribution of a single
 * skill; over-long content is truncated rather than dropped so legitimate large
 * skills still work in a reduced form.
 */
const SKILL_LIMITS = {
  /** Max chars for the skill name (used in the prompt header). */
  name: 100,
  /** Max chars for the one-line frontmatter description. */
  frontmatter: 300,
  /** Max chars for the full instruction body. */
  instructions: 8000,
  /** Max number of match domains. */
  domains: 20,
  /** Max chars for a single domain. */
  domain: 253,
  /** Max number of dangerous-action entries. */
  dangerousActions: 50,
  /** Max chars for a single dangerous-action entry. */
  dangerousAction: 200,
  /** Max number of shortcut entries. */
  shortcuts: 50,
  /** Max chars for a shortcut label / value. */
  shortcutField: 300,
} as const;

/**
 * Sanitize a single untrusted string that will be injected into the trusted
 * system prompt: strip control characters (which can obfuscate prompt-injection
 * payloads or corrupt rendering), neutralize sequences that could forge a
 * `<system-reminder>` boundary (so a custom skill can't close/open the
 * injection wrapper and escape its block), and hard-cap the length.
 */
function sanitizeSkillText(value: string, maxLen: number): string {
  const cleaned = value
 // Strip C0/C1 control chars except tab (\t), newline (\n), carriage return (\r).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
 // Neutralize forged system-reminder open/close tags.
    .replace(/<(\/?\s*system-reminder\b[^>]*)>/gi, "[$1]");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * Normalize a single raw custom-skill object into a validated {@link DomainSkill}.
 *
 * `chrome.storage.local` is the trust boundary for custom skills: a corrupted
 * or injected payload must not flow verbatim into the (TRUSTED) system prompt.
 * We require `name` + at least one `domain`, coerce `instructions`/`frontmatter`
 * to strings, constrain the optional `dangerousActions` / `shortcuts` shapes,
 * and — because this content is untrusted — content-sanitize and length-cap
 * every field so a hostile/oversized payload cannot inject prompt boundaries or
 * bloat the system prompt (token / cost DoS).
 * Returns `null` for any object that fails validation so the caller can drop it.
 */
function normalizeCustomSkill(raw: unknown): DomainSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name) return null;

  const name = sanitizeSkillText(s.name, SKILL_LIMITS.name);
  if (!name) return null; // name collapsed to empty after sanitization

  const domains: string[] = (
    Array.isArray(s.domains)
      ? s.domains.filter((d): d is string => typeof d === "string" && d.length > 0)
      : typeof s.domain === "string"
        ? [s.domain]
        : []
  )
    .map((d) => sanitizeSkillText(d, SKILL_LIMITS.domain).trim())
    .filter((d) => d.length > 0)
    .slice(0, SKILL_LIMITS.domains);
  if (domains.length === 0) return null; // a skill with no domain can never match

  const frontmatter =
    typeof s.frontmatter === "string"
      ? sanitizeSkillText(s.frontmatter, SKILL_LIMITS.frontmatter)
      : name;
  const instructions =
    typeof s.instructions === "string"
      ? sanitizeSkillText(s.instructions, SKILL_LIMITS.instructions)
      : "";
  const dangerousActions = Array.isArray(s.dangerousActions)
    ? s.dangerousActions
        .filter((d): d is string => typeof d === "string")
        .map((d) => sanitizeSkillText(d, SKILL_LIMITS.dangerousAction))
        .filter((d) => d.length > 0)
        .slice(0, SKILL_LIMITS.dangerousActions)
    : undefined;
  const shortcuts =
    s.shortcuts && typeof s.shortcuts === "object"
      ? Object.fromEntries(
          (
            Object.entries(s.shortcuts as Record<string, unknown>).filter(
              ([k, v]) => typeof k === "string" && typeof v === "string",
            ) as Array<[string, string]>
          )
            .slice(0, SKILL_LIMITS.shortcuts)
            .map(
              ([k, v]) =>
                [
                  sanitizeSkillText(k, SKILL_LIMITS.shortcutField),
                  sanitizeSkillText(v, SKILL_LIMITS.shortcutField),
                ] as [string, string],
            )
            .filter(([k]) => k.length > 0),
        )
      : undefined;

  return {
    domains,
    name,
    frontmatter,
    instructions,
    ...(dangerousActions && dangerousActions.length ? { dangerousActions } : {}),
    ...(shortcuts && Object.keys(shortcuts).length ? { shortcuts } : {}),
  };
}

/** Validate a raw `chrome.storage.local` value into a clean `DomainSkill[]`. */
function validateCustomSkills(stored: unknown): DomainSkill[] {
  if (!Array.isArray(stored)) return [];
  const out: DomainSkill[] = [];
  for (const item of stored) {
    const skill = normalizeCustomSkill(item);
    if (skill) out.push(skill);
    else console.error("[domain-skills] Skipping malformed custom skill:", item);
  }
  return out;
}

async function loadCustomDomainSkills(): Promise<DomainSkill[]> {
  if (customSkillsCache !== null) return customSkillsCache;
  try {
    if (isExtensionWithLocal()) {
      const res = await chrome.storage.local.get(CUSTOM_SKILLS_STORAGE_KEY);
      customSkillsCache = validateCustomSkills(res[CUSTOM_SKILLS_STORAGE_KEY]);
      return customSkillsCache;
    }
  } catch (e) {
    console.error("[domain-skills] Failed to load custom skills from storage:", e);
  }
 // Non-extension context or storage access denied: cache the empty result so
 // the `customSkillsCache !== null` short-circuit works and we don't re-run
 // the (no-op) path on every call.
  customSkillsCache = [];
  return customSkillsCache;
}

/**
 * Lightweight skill descriptor — name + frontmatter only. Always in context
 * (the navigator sees this every step so it knows which skills are available
 * without paying the token cost of the full instruction bodies).
 */
export interface SkillFrontmatter {
  /** Skill name (matches what `load_skill` accepts). */
  name: string;
  /** One-sentence description of what the skill covers. */
  description: string;
}

/**
 * Get the lightweight frontmatter (name + one-sentence description) for every
 * skill matching the given URL. This is the "always in context" view — the
 * navigator sees the names and short descriptions every step and uses
 * `load_skill` to pull the full instructions on demand.
 *
 * Invalid URLs return an empty array (fail-safe). In non-extension contexts
 * (no chrome.storage) only built-in skills are returned.
 */
export async function getSkillFrontmatter(url: string): Promise<SkillFrontmatter[]> {
  const skills = await getDomainSkills(url);
 // De-duplicate by name (twitter.com + x.com both match for the same page —
 // the navigator only needs to see "Twitter/X" once in its available-skills list).
  const seen = new Set<string>();
  const out: SkillFrontmatter[] = [];
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      description: s.frontmatter ?? s.name ?? "",
    });
  }
  return out;
}

/**
 * Get the full instruction body for a named skill (loaded on-demand via the
 * `load_skill` action). Returns the empty string if no skill with that name
 * exists, so the executor can surface a clean "skill not found" message
 * without throwing.
 *
 * Searches both built-in skills AND user-defined custom skills (loaded from
 * chrome.storage.local). The first match wins; built-ins are checked first
 * so user-defined skills can't shadow the bundled ones.
 */
export async function getFullSkill(name: string): Promise<string> {
  for (const skill of BUILT_IN_SKILLS) {
    if (skill.name === name) {
      let body = skill.instructions;
      if (skill.dangerousActions?.length) {
        body += `\n\nDangerous actions on this site: ${skill.dangerousActions.join(", ")}`;
      }
      if (skill.shortcuts && Object.keys(skill.shortcuts).length > 0) {
        body += `\n\nShortcuts:`;
        for (const [label, how] of Object.entries(skill.shortcuts)) {
          body += `\n- ${label}: ${how}`;
        }
      }
      return body;
    }
  }
  const custom = await loadCustomDomainSkills();
  for (const skill of custom) {
    if (skill?.name === name) {
      let body = skill.instructions ?? "";
      if (skill.dangerousActions?.length) {
        body += `\n\nDangerous actions on this site: ${skill.dangerousActions.join(", ")}`;
      }
      if (skill.shortcuts && Object.keys(skill.shortcuts).length > 0) {
        body += `\n\nShortcuts:`;
        for (const [label, how] of Object.entries(skill.shortcuts)) {
          body += `\n- ${label}: ${how}`;
        }
      }
      return body;
    }
  }
  return "";
}

/**
 * Shared internal matcher — used by both {@link getSkillFrontmatter} (always in
 * context) and {@link getFullSkill} (on-demand via the `load_skill` action).
 *
 * Get all matching domain skills for a URL — both built-in AND user-defined
 * custom skills (loaded from chrome.storage.local).
 *
 * Matches the URL's hostname against every skill's `domain`. Invalid URLs
 * return an empty array (fail-safe). In non-extension contexts (no
 * chrome.storage) only built-in skills are returned.
 */
export async function getDomainSkills(url: string): Promise<DomainSkill[]> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  const matches: DomainSkill[] = [];
  for (const skill of BUILT_IN_SKILLS) {
 // check all domains in the array (was single `skill.domain`)
    if (skill.domains.some((d) => hostnameMatches(hostname, d))) {
      matches.push(skill);
    }
  }
 // Merge user-defined custom skills (chrome.storage.local). In the demo /
 // test context (no chrome.storage), this returns [] and the function
 // behaves identically to the old built-in-only version. Custom skills are
 // always normalized by `normalizeCustomSkill` (which sets `domains`), so the
 // legacy single-`domain` fallback here is dead code (finding: redundant
 // legacy `skill.domain` fallback in getDomainSkills is dead code) and has
 // been removed.
  const custom = await loadCustomDomainSkills();
  for (const skill of custom) {
    if (
      typeof skill?.name === "string" &&
      Array.isArray(skill.domains) &&
      skill.domains.some((d: string) => hostnameMatches(hostname, d))
    ) {
      matches.push(skill);
    }
  }
  return matches;
}
