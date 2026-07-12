/**
 * `find_elements` action handler — locate elements by CSS selector or a W3C
 * `By.*` locator prefix (`xpath:`, `id:`, `name:`, `tag:`, `class:`, `link:`,
 * `partial:`). Returns the matched elements' tag + text or picked attributes.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";
import { isSensitive } from "../../dom/utils/classification";
import { redactSecrets } from "../../secrets";

/**
 * Attempt `document.querySelectorAll` and return a structured result instead of
 * letting an invalid selector throw. LLM- or prompt-supplied selectors are
 * frequently malformed (e.g. an XPath given without the `xpath:` prefix, or a
 * stray `>>>`), so every failure must surface as `{ success: false, message }`
 * like the sibling handlers, not as a rejected promise.
 */
function tryQuerySelectorAll(
  selector: string,
): { ok: true; els: Element[] } | { ok: false; error: string } {
  try {
    return { ok: true, els: Array.from(document.querySelectorAll(selector)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The set of CSS pseudo-classes that are meaningful on a `<a>` link element and
 * that the `link:` locator should divert to the CSS path. Everything else is
 * treated as ordinary link text and resolved via `By.linkText`.
 *
 * We use an explicit allowlist rather than "is `link:<value>` valid CSS" because
 * many ordinary link texts happen to be syntactically valid CSS — e.g.
 * `link:first-child`, `link:not(.x)`, `link:nth-of-type(2)` are all valid
 * compound selectors. If we routed any valid-CSS value to `querySelectorAll`, a
 * user asking for link text "first-child" would silently get an unrelated set
 * of elements (and the action would still report success). Reserving the CSS
 * path for only these interaction-state pseudo-classes keeps `link:` behaving
 * as documented (By.linkText) while still supporting `link:hover` etc.
 */
const LINK_CSS_PSEUDO_CLASSES = new Set([
  "hover",
  "active",
  "focus",
  "visited",
  "focus-visible",
  "focus-within",
]);

function linkValueIsCssPseudoClass(value: string): boolean {
  return LINK_CSS_PSEUDO_CLASSES.has(value);
}

export async function handleFindElements(
  _ctx: ActionContext,
  action: Extract<Action, { type: "find_elements" }>,
): Promise<ActionResult> {
 // When the selector carries a locator-strategy prefix (`xpath:`, `id:`,
 // `name:`, `tag:`, `class:`, `link:`, `partial:`), resolve via the
 // corresponding `By.*` factory + `findByLocator` instead of
 // `querySelectorAll`. The bare-string CSS path (no prefix) is preserved
 // as the default so existing prompts / callers see no behavior change.
 //
 // Recognized prefixes mirror the W3C `By` taxonomy:
 // css: → By.css(selector) [default when no prefix]
 // xpath: → By.xpath(selector)
 // id: → By.id(selector)
 // name: → By.name(selector)
 // tag: → By.tagName(selector)
 // class: → By.className(selector)
 // link: → By.linkText(selector)
 // partial: → By.partialLinkText(selector)
  const selector = action.selector;
  const prefixMatch = /^(css|xpath|id|name|tag|class|link|partial):([\s\S]+)$/i.exec(selector);
  const kind = prefixMatch?.[1]?.toLowerCase();
  const value = prefixMatch?.[2] ?? "";
  const isLinkLocator = kind === "link" || kind === "partial";
 // For `link:` the value is human-readable link text. Only divert it to the
 // CSS path when the value is one of the known link-state pseudo-classes
 // (`hover`, `active`, `focus`, `visited`, `focus-visible`, `focus-within`);
 // otherwise it is link text. This keeps `link:home`, `link:login`,
 // `link:first-child`, `link:not(.x)` resolving via the locator while
 // `link:hover` still reaches the CSS path. `partial:` never collides with an
 // element name, so it is always a locator.
  const looksLikeCssPseudoClass = kind === "link" && linkValueIsCssPseudoClass(value);
  const useLocator = prefixMatch !== null && !(isLinkLocator && looksLikeCssPseudoClass);

  let matchedEls: Element[] = [];
  if (useLocator) {
    try {
      const { By, findByLocator } = await import("../../dom/dom-utils");
      let by: InstanceType<typeof By> | null = null;
      switch (kind) {
        case "css":     by = By.css(value); break;
        case "xpath":   by = By.xpath(value); break;
        case "id":      by = By.id(value); break;
        case "name":    by = By.byName(value); break;
        case "tag":     by = By.tagName(value); break;
        case "class":   by = By.className(value); break;
        case "link":    by = By.linkText(value); break;
        case "partial": by = By.partialLinkText(value); break;
      }
      if (by) {
        matchedEls = findByLocator(by);
      }
    } catch {
 // Locator import / resolution failed — fall through to the CSS path
 // with the original (un-prefixed) selector so the action still returns
 // a useful result. An invalid selector here is reported, not thrown.
      const res = tryQuerySelectorAll(selector);
      if (!res.ok) {
        return {
          action,
          success: false,
          message: `Invalid selector "${selector}": ${res.error}`,
        };
      }
      matchedEls = res.els;
    }
  } else {
    const res = tryQuerySelectorAll(selector);
    if (!res.ok) {
      return {
        action,
        success: false,
        message: `Invalid selector "${selector}": ${res.error}`,
      };
    }
    matchedEls = res.els;
  }

 // Schema caps `max_results` at 200; clamp defensively so a value that
 // bypassed validation can't produce a runaway payload fed back into the
 // LLM context / persisted history.
  const cap = Math.min(action.max_results ?? 50, 200);
  const els = matchedEls.slice(0, cap);
  const attrs = action.attributes;
  const results = await Promise.all(els.map(async (el, i) => {
 // Treat an explicitly-empty `attributes: []` the same as an omitted
 // `attributes` so it falls through to the text-content branch instead of
 // emitting an uninformative `i: {}` for every match.
    if (attrs && attrs.length > 0) {
      const picked: Record<string, string> = {};
      for (const a of attrs) {
        const raw = el.getAttribute(a) || "";
        let v: string;
 // Never return a raw sensitive value (password / OTP / credit-card /
 // hidden token) — a page could be probed for secret-laden attributes,
 // and `isSensitive` mirrors the DOM extractor's sensitivity check.
        if (a === "value" && isSensitive(el as HTMLElement)) {
          v = "[value redacted]";
        } else if (raw) {
 // Route attribute values through the same secret redactor used
 // elsewhere, so a stored secret that happens to appear in an
 // attribute (e.g. a `value="%email%"`-substituted field) is not
 // leaked back to the LLM. CRITICAL: redact the *untruncated* value
 // first — slicing before redaction would cut a long secret
 // mid-value and let `redactSecrets` (longest-first alternation)
 // fail to match, leaking a partial secret into the LLM context and
 // the persisted run history.
          v = await redactSecrets(raw);
        } else {
          v = "";
        }
 // Truncate only AFTER redaction so redaction always sees the full
 // value and cannot be defeated by truncation.
        picked[a] = v.slice(0, LIMITS.findElementsTextChars);
      }
      return `${i}: ${JSON.stringify(picked)}`;
    }
 // Default branch: surface the element's visible text content. The text may
 // contain a substituted secret (e.g. a contentEditable field whose value
 // was written by the `input` action), so redact it before it reaches the
 // LLM context / persisted run history. Redact the full text first, then
 // slice, so a secret straddling the truncation boundary is never partially
 // exposed.
    const text = await redactSecrets((el.textContent || "").trim());
    return `${i}: <${el.tagName.toLowerCase()}> ${text.slice(0, LIMITS.findElementsTextChars)}`;
  }));
  return {
    action,
    success: true,
    message: `Found ${els.length} elements matching "${action.selector}"`,
    extractedContent: results.length > 0 ? `Elements:\n${results.join("\n")}` : "No elements found",
  };
}
