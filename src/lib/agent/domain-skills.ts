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

async function loadCustomDomainSkills(): Promise<DomainSkill[]> {
  if (customSkillsCache !== null) return customSkillsCache;
  try {
    if (isExtensionWithLocal()) {
      const res = await chrome.storage.local.get(CUSTOM_SKILLS_STORAGE_KEY);
      const stored = res[CUSTOM_SKILLS_STORAGE_KEY];
      customSkillsCache = Array.isArray(stored) ? (stored as DomainSkill[]) : [];
      return customSkillsCache;
    }
  } catch {
    // Non-extension context or storage access denied — return empty.
  }
  return [];
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
      description: s.frontmatter ?? s.instructions.split("\n")[0] ?? "",
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
 * @legacy Use {@link getSkillFrontmatter} (always in context) + {@link getFullSkill}
 *         (on-demand via the `load_skill` action) instead. Kept for backward
 *         compatibility with code paths that still inject the full skill body.
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
  // behaves identically to the old built-in-only version.
  const custom = await loadCustomDomainSkills();
  for (const skill of custom) {
    // Support both the new `domains: string[]` shape and the legacy
    // `domain: string` shape (custom skills saved before the multi-domain
    // change). Without this fallback, legacy single-domain skills have
    // `domains: undefined`, fail the `Array.isArray` check, and are silently
    // dropped — the user's saved skill stops matching.
    const domains: string[] = Array.isArray(skill?.domains)
      ? skill.domains
      : typeof (skill as unknown as { domain?: unknown })?.domain === "string"
        ? [(skill as unknown as { domain: string }).domain]
        : [];
    if (
      typeof skill?.name === "string" &&
      domains.some((d: string) => hostnameMatches(hostname, d))
    ) {
      matches.push(skill);
    }
  }
  return matches;
}
