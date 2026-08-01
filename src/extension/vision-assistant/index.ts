/**
 * Vision Assistant — public API barrel.
 */

export { VisionAssistant } from "./inference";
export { mergeDetections, renderMergedElementsText } from "./merger";
export { ALL_MODEL_FILE_URLS } from "./model-loader";
export type { Detection, PixelDetection, VisionStatus, DownloadProgress, StatusCallback } from "./types";
export * from "./constants";
