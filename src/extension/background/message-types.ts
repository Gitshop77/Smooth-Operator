import type { AgentMode } from "@/lib/agent/modes";
import { MODE_CONFIGS } from "@/lib/agent/modes";
import type { AgentAction } from "@/lib/agent/types";

export const KNOWN_MODES = new Set(Object.keys(MODE_CONFIGS) as AgentMode[]);

interface RunMessage {
  type: "RUN";
  task: string;
  maxSteps?: number;
  mode?: AgentMode;
}
interface StopMessage {
  type: "STOP";
}
interface StatusMessage {
  type: "STATUS";
}
export interface CdpClickMessage {
  type: "CDP_CLICK";
  rect: { x: number; y: number; width: number; height: number };
  visionIndex?: string;
}
export interface CdpPressAndHoldMessage {
  type: "CDP_PRESS_AND_HOLD";
  x: number;
  y: number;
  holdMs: number;
  delayMs: number;
}
export interface SaveAsPdfMessage {
  type: "SAVE_AS_PDF";
  fileName?: string;
}
export interface ScreenshotMessage {
  type: "SCREENSHOT";
  fileName?: string;
}
export interface TabActionMessage {
  type: "TAB_ACTION";
  action: AgentAction;
}
export interface DetectVisualMessage {
  type: "DETECT_VISUAL";
  query: string;
}
interface ClearVisionCacheMessage {
  type: "CLEAR_VISION_CACHE";
}
export type IncomingMessage =
  | RunMessage
  | StopMessage
  | StatusMessage
  | CdpClickMessage
  | CdpPressAndHoldMessage
  | SaveAsPdfMessage
  | ScreenshotMessage
  | TabActionMessage
  | DetectVisualMessage
  | ClearVisionCacheMessage;
