/**
 * Vision Assistant — public API barrel.
 */
export { VisionAssistant } from "./inference";
export { mergeDetections, renderMergedElementsText } from "./merger";
export { MemoryWatchdog, readMemoryInfo, pushMemoryWarning, consumeMemoryWarning } from "./memory-watchdog";
export type { MemoryInfo, MemoryWarning, MemoryWatchdogOptions } from "./memory-watchdog";
export { toPixelCoords } from "./box-parser";
export { parseGroundingResponse, groundingToDetections } from "./grounding-parser";
export type { GroundingItem } from "./grounding-parser";
export { ModelLoader } from "./model-loader";
export type { Detection, PixelDetection, VisionStatus, DownloadProgress, StatusCallback } from "./types";
export * from "./constants";

