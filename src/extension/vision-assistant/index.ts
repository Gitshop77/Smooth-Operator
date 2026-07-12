/**
 * Vision Assistant — public API barrel.
 */

export { VisionAssistant } from "./inference";
export { mergeDetections, renderMergedElementsText, type MergedElement } from "./merger";
export type { Detection, PixelDetection, VisionStatus, DownloadProgress, StatusCallback } from "./types";
export * from "./constants";
