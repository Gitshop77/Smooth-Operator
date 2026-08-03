/**
 * Compute a fast structural signature of the page's interactive elements.
 * The signature changes when the visible interactive set changes (different
 * tags, types, aria-labels, hrefs, values, or text), so the executor can
 * detect SPA route changes that don't change the URL but do change the DOM.
 *
 * The signature incorporates:
 * - per-element tag/type/aria-label/href/value/text, so a route change that
 * only swaps link targets, input values, or button labels is detected; and
 * - a leading + trailing window of elements (plus the total element count), so
 * a route change confined to below-the-fold content with a stable top nav is
 * still captured rather than falling entirely outside the hashed range.
 *
 * SECRECY NOTE: the value of `<input type="password">` is deliberately excluded
 * from the hash. Folding a password's value into the signature would leak
 * secrets (typed passwords, etc.) if this fingerprint is ever logged,
 * transmitted to the service worker, or sent to a backend for SPA-change
 * detection, and it would otherwise flip the fingerprint on every keystroke
 * inside a login form.
 */
import { FINGERPRINT_MAX_ELEMENTS, FNV_OFFSET_BASIS, FNV_PRIME } from "../constants";

function elementSignature(el: Element): string {
  const type = el.getAttribute("type") || "";
  const ariaLabel = el.getAttribute("aria-label") || "";
  const href =
    typeof HTMLAnchorElement !== "undefined" && el instanceof HTMLAnchorElement
      ? el.getAttribute("href") || ""
      : "";
  const value = getElementValue(el);
  // Bound the hashed `text` length. `.slice(0, 256)` limits how many
  // characters of `text` enter the FNV hash (keeping the signature compact
  // for text-heavy elements); it does NOT avoid allocating the full
  // `textContent` string — that is always materialized by the DOM.
  const text = (el.textContent || "").trim().slice(0, 256);
  // Cap the CONCATENATED signature too, so a long `aria-label`/`href`/`value`
  // cannot push the per-element string past the bound the comment above
  // promises. `text` alone is already capped; this guards the other fields.
  return (el.tagName + type + ariaLabel + href + value + text).slice(0, 256);
}

function getElementValue(el: Element): string {
 // Feature-detect the DOM element globals so this helper can't throw
 // `ReferenceError: HTMLInputElement is not defined` if it is ever invoked in a
 // non-DOM context (e.g. the MV3 service worker). In a real page these globals
 // are always present, so page-side behavior is unchanged.
  if (
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) ||
    (typeof HTMLSelectElement !== "undefined" && el instanceof HTMLSelectElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement)
  ) {
 // Never fold a password field's value into the signature. Doing so would
 // leak secrets if the fingerprint is externalized, and would otherwise flip
 // the fingerprint on every keystroke inside a login form. `el.type` is
 // normalized to lowercase by the DOM, so a direct equality check suffices.
    if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) {
      // Skip `value` for transient inputs: typing in them would churn the
      // fingerprint and trigger spurious SPA-route-change detection (the
      // module's purpose is to ignore transient input, exactly as it already
      // does for passwords). For stateful checkbox/radio controls we fold in
      // `checked` instead so meaningful state is still captured.
      const transientTextTypes = ["password", "hidden", "text", "email", "search", "tel", "url", "number"];
      if (transientTextTypes.includes(el.type)) return "";
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? "1" : "0";
    }
 // A <textarea>'s value is just as transient as a text <input> — folding it
 // into the signature would churn the fingerprint on every keystroke and trip
 // spurious SPA-route-change detection. Treat it like the transient inputs
 // (stateful <select> values are still meaningful and kept).
    if (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) return "";
    return el.value;
  }
  return "";
}

/** Fold a string into the running FNV-1a hash (FNV offset basis + prime). */
function hashString(h: number, s: string): number {
  for (let j = 0; j < s.length; j++) {
    h ^= s.charCodeAt(j);
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
}

export function domFingerprint(): string {
  const els = document.querySelectorAll(
    "a,button,input,select,textarea,[role=\"button\"],[role=\"link\"],[role=\"menuitem\"],[role=\"tab\"]",
  );
  let h = FNV_OFFSET_BASIS;

 // Fold the total interactive element count so that additions or removals
 // outside the hashed window are still detected as a fingerprint change.
  h ^= els.length;
  h = Math.imul(h, FNV_PRIME);

 // Hash a leading and a trailing window of interactive elements. The leading
 // window covers a stable top nav; the trailing window catches below-the-fold
 // route changes that would otherwise sit entirely beyond the leading window.
// Iterate only the two windows (not every element) so we don't scan the full
  // list performing a branch per element on large DOMs.
  //
  // When the element list fits within two windows the leading + trailing windows
  // together cover every element between them, so we hash exactly those two
  // windows (when `n <= limit` the leading window alone already covers the
  // whole list, so the trailing pass is skipped). Once the list is longer than
  // two windows, their union leaves a contiguous MIDDLE band unsampled (a SPA
  // route change confined there would be invisible), so we fall back to a
  // strided full-list sample that still bounds the cost to ~2*limit elements
  // while covering the entire list.
  const limit = FINGERPRINT_MAX_ELEMENTS;
  const n = els.length;
  if (n <= limit * 2) {
    for (let i = 0; i < limit && i < n; i++) {
      h = hashString(h, elementSignature(els[i]));
    }
    // A trailing window overlapping the leading one would double-hash the
    // same elements (when `n <= limit` the leading window already covers
    // every element). Only hash the trailing window when it adds elements
    // the leading pass did not see.
    if (n > limit) {
      const lastStart = n - limit;
      for (let i = lastStart; i < n; i++) {
        h = hashString(h, elementSignature(els[i]));
      }
    }
  } else {
    const step = Math.max(1, Math.ceil(n / (limit * 2)));
    for (let i = 0; i < n; i += step) {
      h = hashString(h, elementSignature(els[i]));
    }
  }
  return (h >>> 0).toString(16);
}
