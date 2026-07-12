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
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
  const value = getElementValue(el);
  const text = (el.textContent || "").trim();
  return el.tagName + type + ariaLabel + href + value + text;
}

function getElementValue(el: Element): string {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
 // Never fold a password field's value into the signature. Doing so would
 // leak secrets if the fingerprint is externalized, and would otherwise flip
 // the fingerprint on every keystroke inside a login form. `el.type` is
 // normalized to lowercase by the DOM, so a direct equality check suffices.
    if (el instanceof HTMLInputElement && el.type === "password") {
      return "";
    }
    return el.value;
  }
  return "";
}

export function domFingerprint(): string {
  const els = document.querySelectorAll("a,button,input,select,textarea");
  let h = FNV_OFFSET_BASIS;

 // Fold the total interactive element count so that additions or removals
 // outside the hashed window are still detected as a fingerprint change.
  h ^= els.length;
  h = Math.imul(h, FNV_PRIME);

 // Hash a leading and a trailing window of interactive elements. The leading
 // window covers a stable top nav; the trailing window catches below-the-fold
 // route changes that would otherwise sit entirely beyond the leading window.
  const limit = FINGERPRINT_MAX_ELEMENTS;
  const lastStart = Math.max(0, els.length - limit);
  for (let i = 0; i < els.length; i++) {
    if (i < limit || i >= lastStart) {
      const s = elementSignature(els[i]);
      for (let j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = Math.imul(h, FNV_PRIME);
      }
    }
  }
  return (h >>> 0).toString(16);
}
