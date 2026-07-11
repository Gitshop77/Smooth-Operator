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
 * `link` is a real HTML element name, so `link:hover` parses as a valid CSS
 * selector for hovered `<a>` elements. We therefore disambiguate a `link:`
 * value that is actually a CSS pseudo-class from one that is ordinary link
 * text by checking whether the *whole* `link:<value>` selector is valid CSS.
 * A value that is not valid CSS — including ordinary single-word lowercase
 * link text such as `home`, `login`, `next` — is resolved via `By.linkText`
 * so legitimate one-word links are never silently misrouted to the CSS path.
 * `partial:` never collides with an element name, so it is always a locator.
 */
function linkValueIsCssPseudoClass(value: string): boolean {
  return tryQuerySelectorAll(`link:${value}`).ok;
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
  //   css:     → By.css(selector)         [default when no prefix]
  //   xpath:   → By.xpath(selector)
  //   id:      → By.id(selector)
  //   name:    → By.name(selector)
  //   tag:     → By.tagName(selector)
  //   class:   → By.className(selector)
  //   link:    → By.linkText(selector)
  //   partial: → By.partialLinkText(selector)
  const selector = action.selector;
  const prefixMatch = /^(css|xpath|id|name|tag|class|link|partial):([\s\S]+)$/i.exec(selector);
  const kind = prefixMatch?.[1]?.toLowerCase();
  const value = prefixMatch?.[2] ?? "";
  const isLinkLocator = kind === "link" || kind === "partial";
  // For `link:`/`partial:` the value is human-readable link text. Only divert
  // `link:` to the CSS path when the value is genuinely a CSS pseudo-class
  // (i.e. `link:<value>` is valid CSS); otherwise it is link text. This keeps
  // `link:home`, `link:login`, `partial:next` resolving via the locator while
  // `link:hover` still reaches the CSS path.
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
        case "name":    by = By.name(value); break;
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

  const els = matchedEls.slice(0, action.max_results ?? 50);
  const attrs = action.attributes;
  const results = await Promise.all(els.map(async (el, i) => {
    if (attrs) {
      const picked: Record<string, string> = {};
      for (const a of attrs) {
        let v = el.getAttribute(a) || "";
        // Never return a raw sensitive value (password / OTP / credit-card /
        // hidden token) — a page could be probed for secret-laden attributes,
        // and `isSensitive` mirrors the DOM extractor's sensitivity check.
        if (a === "value" && isSensitive(el as HTMLElement)) {
          v = "[value redacted]";
        } else if (v) {
          // Route attribute values through the same secret redactor used
          // elsewhere, so a stored secret that happens to appear in an
          // attribute (e.g. a `value="%email%"`-substituted field) is not
          // leaked back to the LLM.
          v = await redactSecrets(v);
        }
        picked[a] = v;
      }
      return `${i}: ${JSON.stringify(picked)}`;
    }
    return `${i}: <${el.tagName.toLowerCase()}> ${(el.textContent || "").trim().slice(0, LIMITS.findElementsTextChars)}`;
  }));
  return {
    action,
    success: true,
    message: `Found ${els.length} elements matching "${action.selector}"`,
    extractedContent: results.length > 0 ? `Elements:\n${results.join("\n")}` : "No elements found",
  };
}
