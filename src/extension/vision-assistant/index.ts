/**
 * Vision Assistant — public API barrel.
 */

export { VisionAssistant } from "./inference";
export { mergeDetections, renderMergedElementsText, type MergedElement } from "./merger";
export { parseBoxes, toPixelCoords } from "./box-parser";
export { preprocessScreenshot } from "./preprocessor";
export { ModelLoader } from "./model-loader";
export type { Detection, PixelDetection, VisionStatus, DownloadProgress, StatusCallback } from "./types";
export * from "./constants";
