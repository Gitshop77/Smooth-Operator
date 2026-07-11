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
 * New code should import from `@/lib/agent/dom/extraction/ax-tree-builder`
 *
 */
export * from "./extraction/ax-tree-builder";
