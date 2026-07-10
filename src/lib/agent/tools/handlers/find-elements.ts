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
  let matchedEls: Element[] = [];
  const prefixMatch = /^(css|xpath|id|name|tag|class|link|partial):([\s\S]+)$/i.exec(selector);
  // A CSS pseudo-class like `link:hover` would otherwise be parsed as
  // `By.linkText("hover")` because `link:` is a valid locator prefix AND
  // `link` is a real HTML element name (so `link:hover` is a valid CSS
  // selector for styling `<a>` elements on hover). For the `link:` and
  // `partial:` prefixes specifically — whose values are human-readable link
  // text — require the value to NOT look like a CSS pseudo-class. A CSS
  // pseudo-class name is always a lowercase identifier (optionally with
  // hyphens or parens: `hover`, `first-child`, `nth-child(2)`). Link text
  // like `Sign in`, `Home`, `Click here` either contains a space OR starts
  // with a non-lowercase character. This filter lets `link:Sign in` resolve
  // via By.linkText (existing test) while `link:hover` falls through to the
  // CSS path (querySelectorAll(`link:hover`) → the page's hovered `<a>`s).
  // Other prefixes (`tag:`, `id:`, `name:`, `class:`, `xpath:`, `css:`) are
  // not affected because they don't collide with HTML element names.
  const kind = prefixMatch?.[1]?.toLowerCase();
  const value = prefixMatch?.[2] ?? "";
  const isLinkLocator = kind === "link" || kind === "partial";
  const looksLikeCssPseudoClass = /^[a-z]/.test(value) && !/\s/.test(value);
  const useLocator = prefixMatch !== null && !(isLinkLocator && looksLikeCssPseudoClass);
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
      // Locator import / resolution failed — fall through to the CSS
      // path with the original (un-prefixed) selector so the action
      // still returns a useful result.
      matchedEls = Array.from(document.querySelectorAll(selector));
    }
  } else {
    matchedEls = Array.from(document.querySelectorAll(selector));
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
          v = "[redacted]";
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
