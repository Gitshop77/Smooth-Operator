import type { AgentMode } from "@/lib/agent/modes";
import { MODE_CONFIGS } from "@/lib/agent/modes";
import type { AgentAction } from "@/lib/agent/types";
import type { ConsoleLogEntry } from "@/lib/agent/dom/console-capture";

export type { ConsoleLogEntry } from "@/lib/agent/dom/console-capture";

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
/** One captured network-log entry (SW-side ring, mirrored to the agent). */
export interface NetworkLogRequestEntry {
  type: "request";
  url: string;
  method: string;
  resource_type: string;
  /** Epoch ms when the request was observed. */
  timestamp: number;
}
export interface NetworkLogResponseEntry {
  type: "response";
  url: string;
  status: number;
  /** Epoch ms when the response completed. */
  timestamp: number;
}
export type NetworkLogEntry = NetworkLogRequestEntry | NetworkLogResponseEntry;
export type NetworkLogVerb = "enable" | "disable" | "get" | "clear" | "getclear";
export interface NetworkLogMessage {
  type: "NETWORK_LOG";
  verb: NetworkLogVerb;
}
export type ConsoleLogVerb = "enable" | "disable" | "get" | "clear" | "getclear";
export interface ConsoleLogMessage {
  type: "CONSOLE_LOG";
  verb: ConsoleLogVerb;
}
/** One captured console call relayed from the MAIN-world capture (content side). */
export interface ConsoleLogEntryMessage {
  type: "CONSOLE_LOG_ENTRY";
  entry: ConsoleLogEntry;
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
  | NetworkLogMessage
  | ConsoleLogMessage
  | ConsoleLogEntryMessage
  | ClearVisionCacheMessage;
