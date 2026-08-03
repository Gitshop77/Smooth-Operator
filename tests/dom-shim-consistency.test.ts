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
 * - For each shim we import the shim (`@/lib/agent/dom/<shim>`) and its
 * canonical target(s) (`@/lib/agent/dom/<canonical>`), then compare the
 * sorted set of exported names.
 * - Most shims here re-export the FULL canonical surface (`export *`), so we
 * assert EXACT equality of the key sets. A few legitimately re-export only a
 * SUBSET of their canonical module and use the `subset` relation (see below),
 * which only verifies the canonical exports are present in the shim.
 * - `dom-utils` aggregates four canonical `utils/*` modules; we merge their
 * export names and assert exact equality against the shim.
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

import * as axTreeShim from "@/lib/agent/dom/ax-tree";
import * as axTreeCanonical from "@/lib/agent/dom/extraction/ax-tree-builder";

import * as extractorShim from "@/lib/agent/dom/extractor";
import * as extractorPageState from "@/lib/agent/dom/extraction/page-state";
import * as extractorElementInfo from "@/lib/agent/dom/extraction/element-info";
import * as extractorClassification from "@/lib/agent/dom/utils/classification";

type Relation = "exact" | "subset" | "shim-subset";

const sortedKeys = (mod: Record<string, unknown>): string[] =>
  Object.keys(mod).sort();

function assertConsistent(
  shimName: string,
  shimKeys: string[],
  canonicalName: string,
  canonicalKeys: string[],
  relation: Relation,
): void {
  const shimSet = new Set(shimKeys);
  const canonicalSet = new Set(canonicalKeys);
  if (relation === "exact") {
    const added = shimKeys.filter((k) => !canonicalSet.has(k));
    const removed = canonicalKeys.filter((k) => !shimSet.has(k));
    expect(added, `${shimName} has unexpected exports: ${added}`).toEqual([]);
    expect(removed, `${shimName} is missing exports: ${removed}`).toEqual([]);
  } else if (relation === "subset") {
    // subset: every canonical export must be present in the shim.
    const missing = canonicalKeys.filter((k) => !shimSet.has(k));
    expect(
      missing,
      `${shimName} is missing canonical exports from ${canonicalName}: ${missing.join(", ")}`,
    ).toEqual([]);
  } else {
    // shim-subset: a selective re-export shim must not export any symbol the
    // canonical modules don't have (drift would mean a moved/removed symbol
    // still resolves through the shim).
    const extra = shimKeys.filter((k) => !canonicalSet.has(k));
    expect(
      extra,
      `${shimName} exports unknown symbols not present in ${canonicalName}: ${extra.join(", ")}`,
    ).toEqual([]);
  }
}

describe("DOM re-export shim consistency", () => {
  const simpleCases: Array<
    [string, Record<string, unknown>, Record<string, unknown>, string, Relation]
  > = [
    ["overlay", overlayShim, overlayCanonical, "@/lib/agent/dom/annotation/overlay-renderer", "subset"],
    ["shadow-piercer", shadowPiercerShim, shadowPiercerCanonical, "@/lib/agent/dom/annotation/shadow-piercer", "exact"],
    ["screenshot-annotator", screenshotAnnotatorShim, screenshotAnnotatorCanonical, "@/lib/agent/dom/annotation/screenshot-annotator", "exact"],
    ["phantom-cursor", phantomCursorShim, phantomCursorCanonical, "@/lib/agent/dom/interaction/hover", "subset"],
    ["popup-handler", popupHandlerShim, popupHandlerCanonical, "@/lib/agent/dom/navigation/popup-handler", "subset"],
  ];

  it.each(simpleCases)(
    "%s shim mirrors its canonical",
    (name, shim, canonical, canonicalPath, relation) => {
      assertConsistent(
        "@/lib/agent/dom/" + name,
        sortedKeys(shim),
        canonicalPath,
        sortedKeys(canonical),
        relation,
      );
    },
  );

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

  it("ax-tree shim mirrors the canonical ax-tree-builder exactly (incl. __test_* hooks)", () => {
    assertConsistent(
      "@/lib/agent/dom/ax-tree",
      sortedKeys(axTreeShim),
      "@/lib/agent/dom/extraction/ax-tree-builder",
      sortedKeys(axTreeCanonical),
      "exact",
    );
  });

  it("extractor shim only re-exports symbols that exist in its canonical modules", () => {
    const canonicalKeys = [
      ...sortedKeys(extractorPageState),
      ...sortedKeys(extractorElementInfo),
      ...sortedKeys(extractorClassification),
    ].sort();
    assertConsistent(
      "@/lib/agent/dom/extractor",
      sortedKeys(extractorShim),
      "aggregated ./extraction/{page-state,element-info} + ./utils/classification",
      canonicalKeys,
      "shim-subset",
    );
  });
});
