import type { AgentMode } from "@/lib/agent/modes";
import { MODE_CONFIGS } from "@/lib/agent/modes";
import type { AgentAction } from "@/lib/agent/types";
import type { HumanInteractionRequest, HumanInteractionResponse } from "@/lib/agent/human-interaction";
import type { ConsoleLogEntry } from "@/lib/agent/dom/console-capture";
import type { ScheduledTask } from "@/lib/agent/scheduled-tasks";
import type { OptionsPlatformCommandMessageV1 } from "../options-platform-contract";

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
export type ScheduledTaskCommand =
  | { kind: "list" }
  | { kind: "save"; task: ScheduledTask; expectedRevision: number | null }
  | {
      kind: "set_enabled";
      taskId: string;
      enabled: boolean;
      expectedRevision: number;
      expectedEnabled: boolean;
    }
  | {
      kind: "delete";
      taskId: string;
      expectedRevision: number;
      expectedCreatedAt: number;
    }
  | { kind: "export" }
  | { kind: "import"; tasks: unknown[] };
export interface ScheduledTaskCommandMessage {
  type: "SCHEDULED_TASK_COMMAND";
  /** Additive command contract version; absent is the supported legacy V0 adapter. */
  version?: 1;
  command: ScheduledTaskCommand;
}
/** Background-owned run-history commands (Options never read-modify-writes the
 *  whole history list directly). */
export type HistoryCommand =
  | { kind: "list" }
  | { kind: "clear" }
  | { kind: "export" }
  | { kind: "import"; entries: unknown[]; expectedRevision: number };
export interface HistoryCommandMessage {
  type: "HISTORY_COMMAND";
  version: 1;
  command: HistoryCommand;
}
export interface ActionEffectAuthorizationMessage {
  type: "AUTHORIZE_ACTION_EFFECT";
  token: PrivilegedDispatchToken;
  action: AgentAction;
}
/** Immutable origin identity required while a controller is active. */
export interface PrivilegedDispatchToken {
  runId: string;
  dispatchRevision: number;
}
export interface HumanInteractRequestMessage {
  type: "HUMAN_INTERACT_REQUEST";
  interactionId: string;
  token: PrivilegedDispatchToken;
  request: HumanInteractionRequest;
  timeoutMs: number;
}
export interface HumanInteractResponseMessage {
  type: "HUMAN_INTERACT_RESPONSE";
  interactionId: string;
  token: PrivilegedDispatchToken;
  response: HumanInteractionResponse;
}
export interface HumanInteractCancelMessage {
  type: "HUMAN_INTERACT_CANCEL";
  interactionId: string;
  token: PrivilegedDispatchToken;
}
export interface CdpClickMessage {
  type: "CDP_CLICK";
  rect: { x: number; y: number; width: number; height: number };
  visionIndex?: string;
  action?: Extract<AgentAction, { type: "click" }>;
  token?: PrivilegedDispatchToken;
  effectCapability?: string;
}
export interface CdpPressAndHoldMessage {
  type: "CDP_PRESS_AND_HOLD";
  x: number;
  y: number;
  holdMs: number;
  delayMs: number;
  action?: Extract<AgentAction, { type: "press_and_hold" }>;
  token?: PrivilegedDispatchToken;
  effectCapability?: string;
}
export interface SaveAsPdfMessage {
  type: "SAVE_AS_PDF";
  fileName?: string;
  /** Original validated action, used to match a background confirmation grant. */
  action?: Extract<AgentAction, { type: "save_as_pdf" }>;
  token: PrivilegedDispatchToken;
  effectCapability?: string;
}
export interface ScreenshotMessage {
  type: "SCREENSHOT";
  fileName?: string;
  /** Original validated action, used to match a background confirmation grant. */
  action?: Extract<AgentAction, { type: "screenshot" }>;
  token: PrivilegedDispatchToken;
  effectCapability?: string;
}
export interface TabActionMessage {
  type: "TAB_ACTION";
  action: AgentAction;
  token: PrivilegedDispatchToken;
  effectCapability?: string;
}
export interface DetectVisualMessage {
  type: "DETECT_VISUAL";
  query: string;
  token?: PrivilegedDispatchToken;
  effectCapability?: string;
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
  token?: PrivilegedDispatchToken;
  /** One-time proof bound to the canonical action represented by `verb`. */
  effectCapability?: string;
}
export type ConsoleLogVerb = "enable" | "disable" | "get" | "clear" | "getclear";
export interface ConsoleLogMessage {
  type: "CONSOLE_LOG";
  verb: ConsoleLogVerb;
  token?: PrivilegedDispatchToken;
  /** One-time proof bound to the canonical action represented by `verb`. */
  effectCapability?: string;
}
/** One captured console call relayed from the MAIN-world capture (content side). */
export interface ConsoleLogEntryMessage {
  type: "CONSOLE_LOG_ENTRY";
  entry: ConsoleLogEntry;
}
export interface ClearVisionCacheMessage {
  type: "CLEAR_VISION_CACHE";
  token?: PrivilegedDispatchToken;
}
export type IncomingMessage =
  | RunMessage
  | StopMessage
  | StatusMessage
  | ScheduledTaskCommandMessage
  | HistoryCommandMessage
  | OptionsPlatformCommandMessageV1
  | ActionEffectAuthorizationMessage
  | HumanInteractRequestMessage
  | HumanInteractResponseMessage
  | HumanInteractCancelMessage
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
