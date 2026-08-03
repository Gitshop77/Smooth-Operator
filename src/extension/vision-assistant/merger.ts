/**
 * Vision Assistant — merger.
 *
 * Merges DOM-walker elements with LocateAnything vision detections.
 * Deduplicates by IoU (Intersection over Union) — if a vision box overlaps
 * >50% with a DOM element's rect, the DOM element wins (it's more precise).
 * Vision-only elements get [v-N] indices and are clickable via CDP coords.
 *
 * Coordinate-space notes:
 * - DOM `rect`s come from `getBoundingClientRect()` → CSS pixels,
 * viewport-relative (origin at the visible viewport's top-left corner).
 * - Vision `pixelBox`es come from `chrome.tabs.captureVisibleTab` → device
 * pixels (= CSS pixels × `devicePixelRatio`), also viewport-relative.
 * - To make the IoU comparison meaningful, we divide the vision rect by
 * `devicePixelRatio` to bring it into CSS-pixel space before comparing
 * with DOM rects. (The cached `pixelRect` stored for CDP click is
 * similarly divided so CDP `Input.dispatchMouseEvent` — which consumes
 * CSS pixels — clicks at the right spot.)
 */

import type { ExtractedElement } from "@/lib/agent/types";
import type { PixelDetection } from "./types";

export interface MergedElement extends ExtractedElement {
  /** "dom" if from DOM walker, "vision" if from LocateAnything only */
  source: "dom" | "vision";
  /**
 * Pixel coordinates for CDP clicks, in **CSS pixels** (viewport-relative).
 * Vision-only elements use this; DOM elements fall back to `rect`.
 */
  pixelRect?: { x: number; y: number; width: number; height: number };
  /** Index string: "[1]" for DOM, "[v1]" for vision (used in elementsText). */
  indexStr: string;
  /**
 * Bare vision id (e.g. "v1", no brackets). Used as the cache key for
 * `getVisionElementRect` lookups — the click handler sends the bare form
 * (matching the LLM's emitted `index`), not the bracketed form.
 */
  visionId?: string;
}

/** Calculate IoU (Intersection over Union) of two rects. */
function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
 // Early-out: disjoint boxes never intersect, so the IoU is 0.
  if (
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  ) {
    return 0;
  }
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;

  const union = a.width * a.height + b.width * b.height - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

/**
 * Merge DOM elements with vision detections.
 *
 * @param domElements Interactive elements extracted by the DOM walker.
 * Their `rect`s are in CSS pixels, viewport-relative.
 * @param visionDetections Detections from LocateAnything. Their `pixelBox`es
 * are in device pixels (= CSS × DPR), viewport-relative.
 * @param devicePixelRatio The tab's `window.devicePixelRatio`. Used to scale
 * vision rects DOWN to CSS pixels for both (a) the IoU
 * dedup comparison against DOM rects and (b) the
 * cached `pixelRect` consumed by the CDP click handler.
 * Pass `1` when running in a 1:1 environment.
 */
export function mergeDetections(
  domElements: ExtractedElement[],
  visionDetections: PixelDetection[],
  devicePixelRatio: number = 1,
): MergedElement[] {
 // Guard against a 0/NaN DPR (which would produce Infinity/NaN coords). The
 // vision→CSS division trusts `devicePixelRatio` as the screenshot's true
 // pixel scale. We require it to be a finite number in a sane range
 // (0.5–4): a value outside that band almost certainly means the caller
 // passed the wrong scale (zoomed viewport, moved window, or a background-
 // context capture DPR that disagrees with the page DPR), which would
 // mis-localize every vision-guided click. Clamp to the nearest sane bound
 // and warn rather than silently producing garbage coordinates.
  let dpr = Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  if (!(dpr > 0)) dpr = 1;
  if (dpr < 0.5 || dpr > 4) {
    console.warn(
      `mergeDetections: devicePixelRatio=${devicePixelRatio} is out of the sane range ` +
        `[0.5, 4]; using clamped ${Math.min(4, Math.max(0.5, dpr))}. ` +
        `Vision→CSS coordinate mapping may be mis-localized.`,
    );
    dpr = Math.min(4, Math.max(0.5, dpr));
  }
  const merged: MergedElement[] = [];

 // 1. Add all DOM elements with [N] indices
  for (let i = 0; i < domElements.length; i++) {
    const el = domElements[i];
    merged.push({
      ...el,
      source: "dom",
      indexStr: `[${el.index}]`,
    });
  }

 // 2. Add vision-only elements (those that don't overlap with any DOM element
 // OR with an already-accepted vision element). Two overlapping boxes for the
 // same on-screen object would otherwise both become separate `[vN]` elements
 // — duplicate click targets and doubled prompt tokens.
  let vIdx = 1;
  const acceptedVisionRects: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const det of visionDetections) {
 // Scale the vision rect from device pixels → CSS pixels so the IoU
 // comparison is apples-to-apples with DOM `getBoundingClientRect` rects.
    const visionRectCss = {
      x: det.pixelBox.x / dpr,
      y: det.pixelBox.y / dpr,
      width: det.pixelBox.width / dpr,
      height: det.pixelBox.height / dpr,
    };
    let isDuplicate = false;

    for (const domEl of domElements) {
      if (!domEl.rect) continue;
      if (iou(visionRectCss, domEl.rect) > 0.5) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      for (const prior of acceptedVisionRects) {
        if (iou(visionRectCss, prior) > 0.5) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) {
      acceptedVisionRects.push(visionRectCss);
      const visionId = `v${vIdx}`;
      vIdx++;
      merged.push({
        index: -1, // Vision elements use negative indices to distinguish from DOM
        tag: "vision_element",
        text: det.label || "element",
        attributes: {
          "data-vision-label": det.label,
          "data-vision-x": String(Math.round(visionRectCss.x)),
          "data-vision-y": String(Math.round(visionRectCss.y)),
          "data-vision-w": String(Math.round(visionRectCss.width)),
          "data-vision-h": String(Math.round(visionRectCss.height)),
        },
        hash: `vision_${visionId}_${det.label}`,
        rect: visionRectCss,
        source: "vision",
 // Cache the CSS-pixel rect so CDP `Input.dispatchMouseEvent` (which
 // consumes CSS pixels) clicks at the right spot.
        pixelRect: visionRectCss,
        indexStr: `[${visionId}]`,
        visionId,
      });
    }
  }

  return merged;
}

/**
 * Maximum length of element text/label emitted into the LLM prompt.
 * Applied uniformly to both DOM element text and vision labels so the two
 * element representations stay consistent and the prompt cannot be inflated
 * by an unbounded label.
 */
const MAX_ELEMENT_TEXT_LEN = 80;

/**
 * Escape a string for safe interpolation inside an XML attribute value or
 * text node. Matches the page-state extractor's `attrString` escaping so the
 * merged elements tree stays parseable when attribute values contain `"`,
 * `<`, `>`, or `&` (common in `value`, `placeholder`, `aria-label`).
 *
 * SECURITY: This serialization is fed to the navigator LLM, NOT injected into
 * the DOM. Attribute values are always wrapped in DOUBLE quotes, so the `'`
 * escaping below is defense-in-depth only. This string MUST NEVER be assigned
 * to `innerHTML` (or parsed as live markup). If that ever changes, also ensure
 * values are sanitized; the escaping here keeps it parseable as XML, not safe
 * to execute.
 */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&apos;",
  );
}

/** Render merged elements as elementsText for the navigator LLM. */
export function renderMergedElementsText(elements: MergedElement[]): string {
  const lines: string[] = [];
  for (const el of elements) {
    if (el.source === "dom") {
 // Render DOM elements in the standard format
      const attrs = Object.entries(el.attributes)
        .map(([k, v]) => `${k}="${escapeXml(String(v))}"`)
        .join(" ");
      const attrStr = attrs ? ` ${attrs}` : "";
      const textStr = el.text
        ? ` ${escapeXml(el.text.slice(0, MAX_ELEMENT_TEXT_LEN))}`
        : "";
      lines.push(`${el.indexStr}<${el.tag}${attrStr} />${textStr}`);
    } else {
      // Vision elements carry CSS-pixel coordinates for CDP clicks, but
      // pixelRect is optional on the type. Guard it: a vision element
      // without coordinates cannot be clicked anyway, so skip its line
      // rather than crash the whole render (a future producer bug would
      // otherwise surface as a runtime TypeError instead of a missing line).
      const r = el.pixelRect;
      if (!r) continue;
      lines.push(
        `${el.indexStr}<vision_element label="${escapeXml(
          el.text.slice(0, MAX_ELEMENT_TEXT_LEN),
        )}" ` +
          `x="${Math.round(r.x)}" y="${Math.round(r.y)}" ` +
          `w="${Math.round(r.width)}" h="${Math.round(r.height)}" />`,
      );
    }
  }
  return lines.join("\n");
}
