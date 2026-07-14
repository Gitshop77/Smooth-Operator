/**
 * Shared test helpers — extracted from the duplicate copy-paste spread across
 * the test suite. Import what you need:
 *
 * import { makeState, makeHistoryItem, installLocalStorageStub,
 * installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";
 *
 * Helpers are pure / side-effect-bounded — no hidden global state (each helper
 * either returns a fresh object or explicitly installs/restores a mock).
 */
export { makeState } from "./make-state";
export { makeHistoryItem } from "./make-history";
export {
  installLocalStorageStub,
  restoreLocalStorageStub,
} from "./local-storage-stub";
export {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
  installViewportMock,
  restoreViewportMock,
} from "./jsdom-layout-mock";
