// ─── Role detection ─────────────────────────────────────────────────────────

/** Implicit ARIA roles for tags that don't need an explicit `role` attribute. */
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading",
  img: "image",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  section: "region",
  article: "article",
  aside: "complementary",
  form: "form",
  table: "table",
  ul: "list", ol: "list",
  li: "listitem",
  label: "label",
};

/** Compute the ARIA role for an element (explicit attribute wins, else implicit). */
export function getRole(el: HTMLElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = el.getAttribute("type");
    if (type === "submit" || type === "button") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "button";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] || "generic";
}

// ─── Attribute serialization ────────────────────────────────────────────────

/** Max length for a single attribute value rendered into the AX-tree. */
const MAX_ATTR_VALUE_LENGTH = 200;

/**
 * Escape an attribute value for safe interpolation into a serialized AX-tree
 * line.
 *
 * SECURITY : the serialized tree's invariant is "one element per line"
 * and is consumed by the navigator LLM as ground-truth page structure. A page
 * controls attribute text (`href`/`type`/`placeholder`/option `value`), which
 * may contain literal newlines/tabs/carriage-returns. Quote-escaping alone
 * lets a hostile page inject line breaks and forge additional AX-tree rows
 * (e.g. a spoofed `link Approve transfer [ref_1] ...` line). Collapse all
 * `\r`/`\n`/`\t` runs to a single space *before* quote-escaping so a value can
 * never span or spoof a line.
 */
export function escapeAttributeValue(s: string): string {
  let out = s
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, '\\"')
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (out.length > MAX_ATTR_VALUE_LENGTH) {
    // The cap applies to the entity-EXPANDED text so the token budget is
    // real: a `<`-dense value (e.g. 200 literal `<`) expands to ~800 chars,
    // and capping the raw value first would let it overshoot up to 4x.
    let cut = MAX_ATTR_VALUE_LENGTH;
    // Every `&` in `out` starts an entity (raw `&` was escaped above), so a
    // cut inside one leaves a dangling `&lt`-style fragment. Back up to the
    // entity start when the entity is incomplete before the cut point.
    const lastAmp = out.slice(0, cut).lastIndexOf("&");
    if (lastAmp >= 0 && !out.slice(lastAmp, cut).includes(";")) {
      cut = lastAmp;
    }
    out = out.slice(0, cut) + "...";
  }
  return out;
}

// ─── Structural checks ─────────────────────────────────────────────────────

/** Structural tags (headings, landmarks) we include for context even if not interactive. */
const STRUCTURAL_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header", "footer", "section", "article", "aside"];

/** Determine whether an element is a structural landmark worth surfacing. */
export function isStructural(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return STRUCTURAL_TAGS.includes(tag) || el.getAttribute("role") !== null;
}
