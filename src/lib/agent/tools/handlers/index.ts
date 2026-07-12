/**
 * Barrel re-export of every action handler. The dispatcher (`executor.ts`)
 * imports from here so adding a new action only requires:
 * 1. Writing a new `handlers/<name>.ts` file.
 * 2. Adding it to this barrel.
 * 3. Adding a case to the dispatcher's switch.
 *
 * Also re-exports `ActionContext` (the shared handler-context type) for the
 * dispatcher.
 */

export type { ActionContext } from "./types";

export { handleClick } from "./click";
export { handleInput } from "./input";
export { handleSelectDropdown } from "./select-dropdown";
export { handleScroll } from "./scroll";
export { handleSendKeys } from "./send-keys";
export { handleNavigate } from "./navigate";
export { handleCloseTab, handleSwitchTab } from "./tab-management";
export { handleGoBack } from "./go-back";
export { handleWait } from "./wait";
export { handleFindText } from "./find-text";
export { handleExtract } from "./extract";
export { handleDone } from "./done";
export { handleSearch } from "./search";
export { handleUploadFile } from "./upload-file";
export { handleScreenshot } from "./screenshot";
export { handleSaveAsPdf } from "./save-as-pdf";
export { handleDropdownOptions } from "./dropdown-options";
export { handleSearchPage } from "./search-page";
export { handleFindElements } from "./find-elements";
export { handleEvaluate } from "./evaluate";
export { handleHover } from "./hover";
export { handlePressAndHold } from "./press-and-hold";
export { handleAskHuman } from "./ask-human";
export { handleTakeover } from "./takeover";
export { handleVerify } from "./verify";
export { handleLoadSkill } from "./load-skill";
export {
  handleAlertAccept,
  handleAlertDismiss,
  handleAlertGetText,
  handleAlertSendKeys,
} from "./alert";
export { handleDetectVisual } from "./detect-visual";
