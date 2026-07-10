/**
 * Selector / locator strategies — CSS escaping + the `By` W3C-style locator
 * taxonomy.
 *
 * Extracted from `dom/dom-utils.ts` (along with the rest of the utils)
 * so the locator code lives alongside its only DOM primitives
 * (`document.querySelectorAll`, `document.evaluate`, etc.).
 *
 * The agent's `find_elements` action historically accepts only a raw CSS
 * selector string. With `By` the agent (and the executor's click fallback)
 * can locate elements via XPath, link text, tag name, name attribute, etc.
 *
 * All factories return a {@link By} instance carrying `{ using, value }` —
 * the same shape as the W3C wire-protocol locator object. The
 * {@link findByLocator} resolver dispatches on `using` to the right DOM
 * primitive (`document.querySelectorAll` for CSS, `document.evaluate` for
 * XPath, a text-node walk for link/partial-link text, etc.).
 */

/** The set of locator strategies supported by {@link findByLocator}. */
export type LocatorUsing =
  | "css selector"
  | "xpath"
  | "link text"
  | "partial link text"
  | "tag name"
  | "class name"
  | "name"
  | "id";

/**
 * A W3C-style locator: a `(using, value)` pair. Built via the {@link By}
 * static factories — never constructed directly.
 */
export class By {
  /** The locator strategy (e.g. `"css selector"`, `"xpath"`). */
  readonly using: LocatorUsing;
  /** The locator value (e.g. the CSS selector string, the XPath expression). */
  readonly value: string;

  constructor(using: LocatorUsing, value: string) {
    this.using = using;
    this.value = value;
  }

  /** `By.css("button.primary")` — locate by CSS selector. */
  static css(selector: string): By {
    return new By("css selector", selector);
  }
  /** Alias for {@link By.css} (matches the W3C `By.cssSelector` naming). */
  static cssSelector(selector: string): By {
    return By.css(selector);
  }
  /** `By.id("submit")` — locate by `id` attribute (escaped into a CSS selector). */
  static id(id: string): By {
    return By.css(`*[id="${escapeCss(id)}"]`);
  }
  /** `By.name("q")` — locate by `name` attribute (escaped into a CSS selector). */
  // @ts-expect-error — TS2699: static `name` conflicts with Function.name; we
  // deliberately shadow it because the W3C locator taxonomy calls this strategy
  // `name` (matching `By.id`, `By.className`, etc.). The shadow only affects
  // static-member access (`By.name(...)`); `Function.name` is still accessible
  // via `Object.getPrototypeOf(By).name` if a caller ever needs it.
  static name(name: string): By {
    return By.css(`*[name="${escapeCss(name)}"]`);
  }
  /** `By.className("btn-primary")` — locate by `class` attribute. */
  static className(name: string): By {
    // class names are whitespace-separated — split and escape each, joined by "."
    const parts = name.trim().split(/\s+/).map((p) => `.${escapeCss(p)}`);
    return By.css(parts.join(""));
  }
  /** `By.tagName("button")` — locate by tag name. */
  static tagName(name: string): By {
    return new By("tag name", name);
  }
  /** `By.xpath("//button[@type='submit']")` — locate by XPath expression. */
  static xpath(expression: string): By {
    return new By("xpath", expression);
  }
  /** `By.linkText("Sign in")` — locate `<a>` whose trimmed text exactly matches. */
  static linkText(text: string): By {
    return new By("link text", text);
  }
  /** `By.partialLinkText("Sign")` — locate `<a>` whose text contains the substring. */
  static partialLinkText(text: string): By {
    return new By("partial link text", text);
  }

  /** Human-readable representation (used in logs + wait descriptions). */
  toString(): string {
    return `By(${this.using}, ${this.value})`;
  }

  /** Serialize to a plain `{ using, value }` object (W3C wire shape). */
  toObject(): { using: LocatorUsing; value: string } {
    return { using: this.using, value: this.value };
  }
}

/**
 * Strict CSSOM-identifier escaper. Escapes a string so it can be safely
 * embedded inside a CSS attribute selector (`[id="…"]`, `[name="…"]`) or a
 * class-name fragment (`.foo`). Mirrors the CSSOM `escape(...)` algorithm
 * used by the source `By.id` / `By.name` / `By.className` factories.
 *
 * Falls back to the platform `CSS.escape` when available (all modern
 * browsers + jsdom) — the hand-rolled loop covers the rare environments
 * where `CSS.escape` is missing.
 */
export function escapeCss(css: string): string {
  if (typeof css !== "string") {
    throw new TypeError("escapeCss: input must be a string");
  }
  // Prefer the platform implementation when available.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(css);
  }
  let ret = "";
  const n = css.length;
  for (let i = 0; i < n; i++) {
    const c = css.charCodeAt(i);
    if (c === 0x0) throw new Error("escapeCss: input contains a NUL byte");
    if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && css.charCodeAt(0) === 0x002d)
    ) {
      ret += "\\" + c.toString(16) + " ";
      continue;
    }
    if (i === 0 && c === 0x002d && n === 1) {
      ret += "\\" + css.charAt(i);
      continue;
    }
    if (
      c >= 0x0080 ||
      c === 0x002d ||
      c === 0x005f ||
      (c >= 0x0030 && c <= 0x0039) ||
      (c >= 0x0041 && c <= 0x005a) ||
      (c >= 0x0061 && c <= 0x007a)
    ) {
      ret += css.charAt(i);
      continue;
    }
    ret += "\\" + css.charAt(i);
  }
  return ret;
}

/**
 * Resolve a {@link By} locator to a live `Element[]` from the current
 * document. Dispatches on `by.using`:
 *
 *   - `css selector` → `document.querySelectorAll(by.value)`
 *   - `xpath` → `document.evaluate(by.value, document, …)` snapshot
 *   - `link text` / `partial link text` → walk all `<a>` elements comparing trimmed text
 *   - `tag name` → `document.getElementsByTagName(by.value)`
 *   - `class name` → `document.getElementsByClassName(by.value)`
 *   - `name` / `id` → resolved at factory time to a CSS selector (delegates to CSS path)
 *
 * Returns an empty array on any error (e.g. invalid XPath) so callers can
 * branch on `.length` without try/catch.
 */
export function findByLocator(by: By): Element[] {
  try {
    switch (by.using) {
      case "css selector":
        return Array.from(document.querySelectorAll(by.value));
      case "xpath": {
        const xpe = document.evaluate(
          by.value,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const out: Element[] = [];
        for (let i = 0; i < xpe.snapshotLength; i++) {
          const n = xpe.snapshotItem(i);
          if (n && n.nodeType === Node.ELEMENT_NODE) out.push(n as Element);
        }
        return out;
      }
      case "link text": {
        const want = by.value.trim().toLowerCase();
        return Array.from(document.getElementsByTagName("a")).filter((a) =>
          (a.textContent || "").trim().toLowerCase() === want,
        );
      }
      case "partial link text": {
        const want = by.value.trim().toLowerCase();
        return Array.from(document.getElementsByTagName("a")).filter((a) =>
          (a.textContent || "").trim().toLowerCase().includes(want),
        );
      }
      case "tag name":
        return Array.from(document.getElementsByTagName(by.value));
      case "class name":
        return Array.from(document.getElementsByClassName(by.value));
      // `name` and `id` are compiled to `css selector` at factory time, so
      // they're handled by the css branch. Keep these cases for completeness
      // (in case a hand-constructed By bypasses the factories).
      case "name":
        return Array.from(document.querySelectorAll(`*[name="${escapeCss(by.value)}"]`));
      case "id":
        return Array.from(document.querySelectorAll(`*[id="${escapeCss(by.value)}"]`));
      default:
        return [];
    }
  } catch {
    // Invalid XPath / bad selector → empty (don't propagate — caller branches on length).
    return [];
  }
}
