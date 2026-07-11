/**
 * DOM re-export shim consistency.
 *
 * Every re-export shim under `src/lib/agent/dom/` is a thin `export *` / thin
 * re-export that mirrors a canonical module living in a sibling `annotation/`,
 * `interaction/`, `navigation/`, or `utils/` directory. Prod handler imports
 * go through the shim, so the shim's surface must stay in lock-step with the
 * canonical module's surface.
 *
 * If a symbol is moved/removed in a canonical file but the shim is not updated,
 * legacy import sites silently break. This test fails the build when a shim
 * drops (or unexpectedly adds) an export relative to its canonical source,
 * catching exactly that drift.
 *
 * Strategy:
 *   - For each shim we import the shim (`@/lib/agent/dom/<shim>`) and its
 *     canonical target(s) (`@/lib/agent/dom/<canonical>`), then compare the
 *     sorted set of exported names.
 *   - Every shim here re-exports the FULL canonical surface (`export *`), so we
 *     assert EXACT equality of the key sets.
 *   - `dom-utils` aggregates four canonical `utils/*` modules; we merge their
 *     export names and assert exact equality against the shim.
 *
 * If, in future, a shim legitimately re-exports only a SUBSET of its canonical
 * module, switch that entry's `relation` to `"subset"` and the assertion will
 * only require "every canonical export is present in the shim" rather than
 * exact equality.
 */

import { describe, it, expect } from "vitest";

import * as overlayShim from "@/lib/agent/dom/overlay";
import * as overlayCanonical from "@/lib/agent/dom/annotation/overlay-renderer";

import * as shadowPiercerShim from "@/lib/agent/dom/shadow-piercer";
import * as shadowPiercerCanonical from "@/lib/agent/dom/annotation/shadow-piercer";

import * as screenshotAnnotatorShim from "@/lib/agent/dom/screenshot-annotator";
import * as screenshotAnnotatorCanonical from "@/lib/agent/dom/annotation/screenshot-annotator";

import * as phantomCursorShim from "@/lib/agent/dom/phantom-cursor";
import * as phantomCursorCanonical from "@/lib/agent/dom/interaction/hover";

import * as popupHandlerShim from "@/lib/agent/dom/popup-handler";
import * as popupHandlerCanonical from "@/lib/agent/dom/navigation/popup-handler";

import * as domUtilsShim from "@/lib/agent/dom/dom-utils";
import * as domUtilsClassification from "@/lib/agent/dom/utils/classification";
import * as domUtilsVisibility from "@/lib/agent/dom/utils/visibility";
import * as domUtilsTreeWalker from "@/lib/agent/dom/utils/tree-walker";
import * as domUtilsSelectors from "@/lib/agent/dom/utils/selectors";

type Relation = "exact" | "subset";

const sortedKeys = (mod: Record<string, unknown>): string[] =>
  Object.keys(mod).sort();

function assertConsistent(
  shimName: string,
  shimKeys: string[],
  canonicalName: string,
  canonicalKeys: string[],
  relation: Relation,
): void {
  if (relation === "exact") {
    expect(shimKeys, `${shimName} exports must equal ${canonicalName} exports`).toEqual(
      canonicalKeys,
    );
  } else {
    // subset: every canonical export must be present in the shim.
    const missing = canonicalKeys.filter((k) => !shimKeys.includes(k));
    expect(
      missing,
      `${shimName} is missing canonical exports from ${canonicalName}: ${missing.join(", ")}`,
    ).toEqual([]);
  }
}

describe("DOM re-export shim consistency", () => {
  it("overlay shim mirrors ./annotation/overlay-renderer", () => {
    assertConsistent(
      "@/lib/agent/dom/overlay",
      sortedKeys(overlayShim),
      "@/lib/agent/dom/annotation/overlay-renderer",
      sortedKeys(overlayCanonical),
      "exact",
    );
  });

  it("shadow-piercer shim mirrors ./annotation/shadow-piercer", () => {
    assertConsistent(
      "@/lib/agent/dom/shadow-piercer",
      sortedKeys(shadowPiercerShim),
      "@/lib/agent/dom/annotation/shadow-piercer",
      sortedKeys(shadowPiercerCanonical),
      "exact",
    );
  });

  it("screenshot-annotator shim mirrors ./annotation/screenshot-annotator", () => {
    assertConsistent(
      "@/lib/agent/dom/screenshot-annotator",
      sortedKeys(screenshotAnnotatorShim),
      "@/lib/agent/dom/annotation/screenshot-annotator",
      sortedKeys(screenshotAnnotatorCanonical),
      "exact",
    );
  });

  it("phantom-cursor shim mirrors ./interaction/hover", () => {
    assertConsistent(
      "@/lib/agent/dom/phantom-cursor",
      sortedKeys(phantomCursorShim),
      "@/lib/agent/dom/interaction/hover",
      sortedKeys(phantomCursorCanonical),
      "exact",
    );
  });

  it("popup-handler shim mirrors ./navigation/popup-handler", () => {
    assertConsistent(
      "@/lib/agent/dom/popup-handler",
      sortedKeys(popupHandlerShim),
      "@/lib/agent/dom/navigation/popup-handler",
      sortedKeys(popupHandlerCanonical),
      "exact",
    );
  });

  it("dom-utils shim mirrors the aggregated ./utils/* modules", () => {
    const canonicalKeys = [
      ...sortedKeys(domUtilsClassification),
      ...sortedKeys(domUtilsVisibility),
      ...sortedKeys(domUtilsTreeWalker),
      ...sortedKeys(domUtilsSelectors),
    ].sort();
    assertConsistent(
      "@/lib/agent/dom/dom-utils",
      sortedKeys(domUtilsShim),
      "aggregated ./utils/{classification,visibility,tree-walker,selectors}",
      canonicalKeys,
      "exact",
    );
  });
});
