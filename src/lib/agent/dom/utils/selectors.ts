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

/** Upper bound on a locator value (CSS selector or XPath expression) length. */
const MAX_LOCATOR_VALUE_LENGTH = 8192;

/** Upper bound on nodes returned by a single locator resolution (anti-DoS cap). */
const MAX_NODES = 100_000;

/**
 * Collect a live `Element[]` from a DOM node collection, keeping only element
 * nodes and stopping once {@link MAX_NODES} is reached. Shared by the CSS /
 * tag / class locator branches so a hostile or pathological selector can't
 * materialize an unbounded array (the `xpath` branch enforces the same element
 * filter inline).
 */
function collectElements(
  nodes: HTMLCollectionOf<Element> | NodeListOf<Element>,
): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node && node.nodeType === 1) {
      out.push(node);
      if (out.length >= MAX_NODES) break;
    }
  }
  return out;
}

/** Render a `By` for logging, truncating a long `value` (e.g. a huge xpath). */
function logBy(by: By): string {
  const v = by.value.length > 200 ? by.value.slice(0, 200) + "…" : by.value;
  return `By(${by.using}, ${v})`;
}

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
  /** `By.id("submit")` — locate by `id` attribute (escaped into a CSS selector). */
  static id(id: string): By {
    return By.css(`*[id="${escapeCss(id)}"]`);
  }
  /**
 * `By.byName("q")` — locate by `name` attribute (escaped into a CSS selector).
 *
 * This was previously named `By.name`, but a `static name` member shadows the
 * class's inherited `Function.name` and triggers TS2699 (`'name' conflicts with
 * the inherited ... name`). A `@ts-expect-error` suppressing that diagnostic is
 * build-fragile: if a future TypeScript version stops emitting TS2699, the
 * directive itself becomes a hard error ("Unused '@ts-expect-error' directive")
 * and the whole project fails to compile. We therefore name the factory
 * `byName` and re-expose it as `By.name` via `Object.defineProperty` below —
 * that defines an own property (shadowing the prototype's `name` accessor)
 * without any type conflict, while preserving the public API for the external
 * `find_elements` handler.
 */
  static byName(name: string): By {
    return By.css(`*[name="${escapeCss(name)}"]`);
  }
  /** `By.className("btn-primary")` — locate by `class` attribute. */
  static className(name: string): By {
 // A class attribute is whitespace-separated; split, escape each token, and
 // join with ".". Guard the empty input: `("").trim().split(/\s+/)` → `[""]`
 // and `(" ").trim().split(/\s+/)` → `[""]`, both of which would produce the
 // invalid selectors `.` / `..` (which `querySelectorAll` rejects). Return a
 // valid no-match selector instead of a degenerate one.
    const trimmed = name.trim();
    if (trimmed === "") {
      return By.css(":not(*)");
    }
    const parts = trimmed.split(/\s+/).map((p) => `.${escapeCss(p)}`);
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
}

/**
 * Backward-compatible alias for {@link By.byName}.
 *
 * We deliberately do NOT declare `static name` on the class: it shadows the
 * inherited `Function.name` and requires the fragile `@ts-expect-error` removed
 * above. Defining an own `name` property here (via `Object.defineProperty`, which
 * succeeds because it shadows the prototype's `name` accessor) keeps
 * `By.name(...)` working for the external `find_elements` handler without the
 * type conflict. Prefer {@link By.byName} in new code.
 */
Object.defineProperty(By, "name", {
  value: By.byName,
  writable: true,
  configurable: true,
  enumerable: false,
});

/**
 * Strict CSSOM-identifier escaper. Escapes a string so it can be safely
 * embedded inside a CSS attribute selector (`[id="…"]`, `[name="…"]`) or a
 * class-name fragment (`.foo`). Mirrors the CSSOM `escape(...)` algorithm
 * used by the source `By.id` / `By.name` / `By.className` factories.
 *
 * Falls back to the platform `CSS.escape` when available (all modern
 * browsers + jsdom) — the hand-rolled loop covers the rare environments
 * where `CSS.escape` is missing.
 *
 * This utility never throws on input content (including NUL bytes): NUL is
 * replaced with U+FFFD, matching `CSS.escape`. This keeps the factories and
 * the {@link findByLocator} resolver consistent — the same input produces the
 * same (non-throwing) result whether `escapeCss` runs at construction time or
 * inside the resolver's try/catch.
 */
export function escapeCss(css: string): string {
  if (typeof css !== "string") {
    throw new TypeError("escapeCss: input must be a string");
  }
 // Prefer the platform implementation when available.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(css);
  }
  const out: string[] = [];
  const n = css.length;
  for (let i = 0; i < n; i++) {
    const c = css.charCodeAt(i);
 // NUL is not representable in CSS; `CSS.escape` substitutes U+FFFD, so we do
 // the same here to keep both code paths equivalent (and never throw).
    if (c === 0x0) {
      out.push("�");
      continue;
    }
    if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && css.charCodeAt(0) === 0x002d)
    ) {
      out.push("\\" + c.toString(16) + " ");
      continue;
    }
    if (i === 0 && c === 0x002d && n === 1) {
      out.push("\\" + css.charAt(i));
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
      out.push(css.charAt(i));
      continue;
    }
    out.push("\\" + css.charAt(i));
  }
  return out.join("");
}

/**
 * Resolve a {@link By} locator to a live `Element[]` from the current
 * document. Dispatches on `by.using`:
 *
 * - `css selector` → `document.querySelectorAll(by.value)`
 * - `xpath` → `document.evaluate(by.value, document, …)` snapshot
 * - `link text` / `partial link text` → walk all `<a>` elements comparing trimmed text
 * - `tag name` → `document.getElementsByTagName(by.value)`
 * - `class name` → `document.getElementsByClassName(by.value)`
 * - `name` / `id` → resolved at factory time to a CSS selector (delegates to CSS path)
 *
 * Returns an empty array on any error (e.g. invalid XPath) so callers can
 * branch on `.length` without try/catch. **This function never throws**, even
 * when resolution fails — the contract is relied on by the `find_elements`
 * handler. Failures are nonetheless surfaced to the console so genuine bugs
 * aren't masked as "no match" (see the notes in the `catch`/`default` below).
 */
const isProd = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production";

export function findByLocator(by: By): Element[] {
  try {
    switch (by.using) {
      case "css selector": {
        if (by.value.length > MAX_LOCATOR_VALUE_LENGTH) {
          if (!isProd()) {
            console.warn(
              "[findByLocator] css selector exceeds",
              MAX_LOCATOR_VALUE_LENGTH,
              "chars; refusing to evaluate",
            );
          }
          return [];
        }
        return collectElements(document.querySelectorAll(by.value));
      }
      case "xpath": {
 // Trust boundary: `by.value` originates from an LLM / prompt-injection-
 // controlled string (the `find_elements` handler). `document.evaluate`
 // uses XPath 1.0 and cannot execute JavaScript, so this is not remote
 // code execution — but an unbounded expression can still perform an
 // expensive read over the entire page DOM. We cap the length to bound
 // pathological input. (The `id`/`name`/`class name` strategies are
 // escaped via `escapeCss` and are NOT injectable.)
        if (by.value.length > MAX_LOCATOR_VALUE_LENGTH) {
          if (!isProd()) {
            console.warn(
              "[findByLocator] xpath expression exceeds",
              MAX_LOCATOR_VALUE_LENGTH,
              "chars; refusing to evaluate",
            );
          }
          return [];
        }
        const xpe = document.evaluate(
          by.value,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const out: Element[] = [];
        for (let i = 0; i < xpe.snapshotLength; i++) {
          const node = xpe.snapshotItem(i);
          if (node && node.nodeType === Node.ELEMENT_NODE) {
            out.push(node as Element);
            if (out.length >= MAX_NODES) break;
          }
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
        return collectElements(document.getElementsByTagName(by.value));
      case "class name":
        return collectElements(document.getElementsByClassName(by.value));
      default:
 // Unknown `using`. The public factories never produce this — it is only
 // reachable via a hand-constructed `By` with a non-standard strategy,
 // i.e. a programming error / misconfiguration. Unlike an invalid
 // selector (genuine user input), this is unexpected: surface it (in every
 // environment, including production) so it isn't silently swallowed as
 // "no match", while still honoring the "never throws" contract.
        console.error("[findByLocator] unknown locator strategy", logBy(by));
        return [];
    }
  } catch (err) {
 // `findByLocator` is documented to never throw (callers branch on `.length`),
 // so a genuine programming error must not be swallowed as "no match".
 //
 // A malformed selector / XPath handed to us by the caller is the *expected*
 // failure mode (it's user-controlled input) — log it only in non-production
 // builds so debugging isn't noisy in prod.
 //
 // Anything else (a `TypeError`, an internal bug, a non-string `value`, …) is
 // *unexpected* and is always surfaced — including in production — because
 // those are the bugs hardest to observe and most damaging when masked.
    const expected =
      err instanceof DOMException || err instanceof SyntaxError;
    if (!expected) {
      console.error("[findByLocator] unexpected error resolving", logBy(by), err);
    } else if (!isProd()) {
      console.warn("[findByLocator] invalid selector/xpath", logBy(by), err);
    }
    return [];
  }
}
