/**
 * Dirty-subtree tracking for partial re-walks.
 *
 * The DOM-epoch mutation signal (`./mutation-signal`) records the TOPMOST
 * mutated subtrees per epoch window. `extractBrowserState` (page-state.ts)
 * consumes them via {@link getDirtyRoots} to re-serialize only the changed
 * regions and splice the results into the previous walk's elements/lines
 * arrays instead of re-walking the whole document. This module is the public
 * surface of that bookkeeping; the recording itself lives next to the epoch
 * counter in the signal module (one observer callback owns both).
 *
 * Consumption protocol:
 * - a walker asks for the roots recorded since its last extraction with
 *   `getDirtyRoots(getDomEpoch())`;
 * - after the walk (full or partial) it calls `clearDirtyRoots(getDomEpoch())`
 *   so a recorded batch is never re-applied to a later splice.
 */
export { getDirtyRoots, clearDirtyRoots } from "./mutation-signal";