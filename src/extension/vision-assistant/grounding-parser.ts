/**
 * Vision Assistant — grounding response parser.
 *
 * LFM2.5-VL emits referring-expression grounding as a JSON array of
 * `{ image_id, bbox_2d | point_2d, label }` objects (per the system prompt in
 * constants.ts). This module parses that output — with a bare-`[x,y,x,y]`
 * fallback for runs where the model skips the JSON wrapper — and normalizes
 * 0-1 and 0-1000 coordinates to canonical 0-1000 ints.
 *
 * Ported from the LiquidAI/LFM2.5-VL-3B-WebGPU Space (`src/grounding.js`) so
 * the behavior matches the model's reference implementation exactly.
 */

import type { Detection } from "./types";

const ALLOWED_KEYS = new Set(["image_id", "label", "bbox_2d", "point_2d"]);

/** A single normalized grounding item (0-1000 int coordinates). */
export interface GroundingItem {
  imageId: number;
  label: string;
  type: "box" | "point";
  coordinates: number[];
}

function normalizeCoordinateArray(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length ||
    !value.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  if (value.every((c) => c >= 0 && c <= 1)) {
    return value.map((c) => Math.round(c * 1000));
  }
  if (value.every((c) => Number.isInteger(c) && c >= 0 && c <= 1000)) {
    return value.slice();
  }
  return null;
}

const BOX_NUMBER = "(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";

/** Fallback: pull bare `[x, y, x, y]` quadruples out of free-form text. */
function parseBareBoxes(text: string): GroundingItem[] {
  const pattern = new RegExp(`\\[\\s*${BOX_NUMBER}\\s*,\\s*${BOX_NUMBER}\\s*,\\s*${BOX_NUMBER}\\s*,\\s*${BOX_NUMBER}\\s*\\]`, "g");
  const boxes: GroundingItem[] = [];
  for (const match of text.matchAll(pattern)) {
    const coordinates = normalizeCoordinateArray(match.slice(1, 5).map(Number), 4);
    if (!coordinates) continue;
    const [xmin, ymin, xmax, ymax] = coordinates;
    if (xmax <= xmin || ymax <= ymin) continue;
    boxes.push({
      imageId: 0,
      label: boxes.length ? `Bounding box ${boxes.length + 1}` : "Bounding box",
      type: "box",
      coordinates,
    });
  }
  return boxes;
}

/**
 * Parse LFM grounding output. Returns `null` when the text is not valid
 * grounding (fenced code, unrelated JSON, malformed coordinates) — the caller
 * then treats the run as "no detections".
 */
export function parseGroundingResponse(text: string, imageCount: number): GroundingItem[] | null {
  if (!Number.isInteger(imageCount) || imageCount < 1 || typeof text !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const boxes = parseBareBoxes(text);
    return boxes.length ? boxes : null;
  }

  if (!Array.isArray(parsed)) {
    const boxes = parseBareBoxes(text);
    return boxes.length ? boxes : null;
  }

  const structuredCandidate = parsed.length === 0 || parsed.every((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!structuredCandidate) {
    const boxes = parseBareBoxes(text);
    return boxes.length ? boxes : null;
  }

  const normalized: GroundingItem[] = [];
  let structured = true;
  for (const item of parsed as Record<string, unknown>[]) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some((k) => !ALLOWED_KEYS.has(k)) ||
      !Number.isInteger(item.image_id) || (item.image_id as number) < 0 || (item.image_id as number) >= imageCount ||
      typeof item.label !== "string" || !(item.label as string).trim()) {
      structured = false;
      break;
    }

    const hasBox = Object.hasOwn(item, "bbox_2d");
    const hasPoint = Object.hasOwn(item, "point_2d");
    if (hasBox === hasPoint) {
      structured = false;
      break;
    }

    if (hasBox) {
      const coordinates = normalizeCoordinateArray(item.bbox_2d, 4);
      if (!coordinates) {
        structured = false;
        break;
      }
      const [xmin, ymin, xmax, ymax] = coordinates;
      if (xmax <= xmin || ymax <= ymin) {
        structured = false;
        break;
      }
      normalized.push({ imageId: item.image_id as number, label: (item.label as string).trim(), type: "box", coordinates });
    } else {
      const coordinates = normalizeCoordinateArray(item.point_2d, 2);
      if (!coordinates) {
        structured = false;
        break;
      }
      normalized.push({ imageId: item.image_id as number, label: (item.label as string).trim(), type: "point", coordinates });
    }
  }

  if (structured) return normalized;
  return null;
}

/**
 * Convert parsed grounding into the detection shape the rest of the extension
 * consumes (`Detection` = label + 0-1000 box). Only box geometry maps to
 * clickable elements; point groundings are dropped (the extension's click
 * model needs a 2D region).
 */
export function groundingToDetections(items: GroundingItem[]): Detection[] {
  const out: Detection[] = [];
  for (const item of items) {
    if (item.type !== "box") continue;
    const [x1, y1, x2, y2] = item.coordinates as [number, number, number, number];
    if (!(x2 > x1) || !(y2 > y1)) continue;
    out.push({ label: item.label, box: [x1, y1, x2, y2] });
  }
  return out;
}
