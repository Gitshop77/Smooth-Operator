/**
 * Compute a fast structural signature of the page's interactive elements.
 * The signature changes when the visible interactive set changes (different
 * tags, types, or aria-labels), so the executor can detect SPA route changes
 * that don't change the URL but do change the DOM.
 */
import { FINGERPRINT_MAX_ELEMENTS, FNV_OFFSET_BASIS, FNV_PRIME } from "../constants";

export function domFingerprint(): string {
  const els = document.querySelectorAll("a,button,input,select,textarea");
  let h = FNV_OFFSET_BASIS;
  const limit = Math.min(els.length, FINGERPRINT_MAX_ELEMENTS);
  for (let i = 0; i < limit; i++) {
    const s = els[i].tagName + (els[i].getAttribute("type") || "") + (els[i].getAttribute("aria-label") || "");
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, FNV_PRIME);
    }
  }
  return (h >>> 0).toString(16);
}
