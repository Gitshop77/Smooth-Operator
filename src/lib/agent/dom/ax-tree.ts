/**
 * Re-export shim — the canonical AX-tree builder implementation now lives in
 * `./extraction/ax-tree-builder`. This file preserves the legacy
 * `@/lib/agent/dom/ax-tree` import path used by `extension/content.ts` and
 * the AX-tree tests.
 *
 * All historically-exported symbols are re-exported here:
 *   - `generateAccessibilityTree`, `initElementMap`, `resolveRef`,
 *     `AXTreeResult` (interface)
 *
 * SECURITY: the element-ref registry (`elementMap`, `elementReverseMap`,
 * `refCounter`) is kept intentionally in the *module scope* of
 * `./extraction/ax-tree-builder` and is NOT exposed on `window`. No
 * `declare global { interface Window { __openCoworkElementMap? } }`
 * augmentation is performed here or in the canonical module — and none should
 * be added. Exposing the registry on `window` would let a hostile page in the
 * shared content-script context read or overwrite an entry and hijack an
 * action's target element. The canonical module documents this in its own
 * SECURITY note; this shim performs no global augmentation.
 *
 * New code should import from `@/lib/agent/dom/extraction/ax-tree-builder`
 *
 */
export * from "./extraction/ax-tree-builder";
