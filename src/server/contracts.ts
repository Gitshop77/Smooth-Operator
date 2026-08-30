import * as z from "zod/v4";

const BoundedString = (max: number) => z.string().trim().min(1).max(max);
// Keyboard input is the one bounded string that must preserve leading,
// trailing, and whitespace-only values: a literal " " is a valid key event.
const KeyboardString = (max: number) => z.string().min(1).max(max);
export const MCP_PAGE_TEXT_MAX_CHARS = 8_000;
// Keep the research input contract and its service/serialization budgets in
// one place. These constants do not add fields to the public MCP schema.
export const RESEARCH_QUERY_MAX_CHARS = 4_000;
export const RESEARCH_MIN_CHARS = 500;
export const RESEARCH_MAX_CHARS = 4_000;
export const RESEARCH_MAX_RESULTS = 10;
const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
};
const HttpUrl = (max: number) => BoundedString(max).refine(isHttpUrl, "URL must be an absolute HTTP(S) URL.");
const PageInput = {
  pageId: BoundedString(200).optional(),
  snapshotId: BoundedString(200).optional(),
  frameId: BoundedString(200).optional(),
  includeSnapshot: z.boolean().optional(),
};

const BrowserActionNames = [
  "click",
  "input",
  "select_dropdown",
  "scroll",
  "scroll_to_bottom",
  "send_keys",
  "navigate",
  "switch_tab",
  "close_tab",
  "go_back",
  "go_forward",
  "reload",
  "wait",
  "wait_for_element",
  "wait_for_text",
  "wait_for_url",
  "wait_for_network_idle",
  "enable_network_log",
  "disable_network_log",
  "get_network_log",
  "search_network_log",
  "clear_network_log",
  "getclear_network_log", // canonical action spelling of the read_and_clear operation
  "enable_console_log",
  "disable_console_log",
  "get_console_log",
  "clear_console_log",
  "getclear_console_log", // canonical action spelling of the read_and_clear operation
  "find_text",
  "extract",
  "get_html",
  "upload_file",
  "screenshot",
  "save_as_pdf",
  "list_downloads",
  "dropdown_options",
  "page_next",
  "search_page",
  "find_elements",
  "list_interactive",
  "list_frames",
  "accessibility_snapshot",
  "get_computed_style",
  "get_page_info",
  "evaluate",
  "run_script",
  "hover",
  "move",
  "press_and_hold",
  "alert_accept",
  "alert_dismiss",
  "alert_get_text",
  "alert_send_keys",
  "detect_challenge",
  "wait_for_human",
  "solve_challenge",
  "list_tabs",
  "get_cookies",
  "set_cookie",
  "delete_cookies",
  "get_storage",
  "set_storage",
  "clear_storage",
  "close_browser",
] as const;

const ActionNameSchema = z.enum(BrowserActionNames);
const PointerPathSchema = z.array(z.object({
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
}).strict()).min(2).max(256).optional();
export type ActionName = z.infer<typeof ActionNameSchema>;

const BrowserActionFieldsSchema = z.object({
  pageId: BoundedString(200).optional(),
  snapshotId: BoundedString(200).optional(),
  frameId: BoundedString(200).optional(),
  target: BoundedString(2_000).optional(),
  ref: z.string().trim().min(1).max(200).regex(/^(?:ref:)?e[1-9]\d*$/, "ref must be an element reference such as e5.").optional(),
  index: z.number().int().min(0).max(1_000).optional(),
  selector: BoundedString(2_000).optional(),
  text: z.string().max(20_000).optional(),
  value: z.string().max(20_000).optional(),
  url: BoundedString(8_000).optional(),
  newTab: z.boolean().optional(),
  new_tab: z.boolean().optional(),
  coordinateX: z.number().finite().min(0).max(100_000).optional(),
  coordinateY: z.number().finite().min(0).max(100_000).optional(),
  coordinate_x: z.number().finite().min(0).max(100_000).optional(),
  coordinate_y: z.number().finite().min(0).max(100_000).optional(),
  startCoordinateX: z.number().finite().min(0).max(100_000).optional(),
  startCoordinateY: z.number().finite().min(0).max(100_000).optional(),
  start_coordinate_x: z.number().finite().min(0).max(100_000).optional(),
  start_coordinate_y: z.number().finite().min(0).max(100_000).optional(),
  path: PointerPathSchema,
  endCoordinateX: z.number().finite().min(0).max(100_000).optional(),
  endCoordinateY: z.number().finite().min(0).max(100_000).optional(),
  end_coordinate_x: z.number().finite().min(0).max(100_000).optional(),
  end_coordinate_y: z.number().finite().min(0).max(100_000).optional(),
  key: KeyboardString(100).optional(),
  keys: z.array(KeyboardString(100)).min(1).max(32).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().finite().min(1).max(100_000).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  milliseconds: z.number().int().min(0).max(120_000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxScrolls: z.number().int().min(1).max(50).optional(),
  restoreTop: z.boolean().optional(),
  state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  filePath: BoundedString(4_000).optional(),
  outputPath: BoundedString(4_000).optional(),
  code: z.string().trim().min(1).max(40_000).optional(),
  script: z.string().trim().min(1).max(40_000).optional(),
  expression: z.string().trim().min(1).max(40_000).optional(),
  query: BoundedString(4_000).optional(),
  requestId: BoundedString(256).optional(),
  method: BoundedString(32).optional(),
  status: z.number().int().min(0).max(999).optional(),
  resourceType: BoundedString(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  includeLinks: z.boolean().optional(),
  includeSnapshot: z.boolean().optional(),
  maxChars: z.number().int().min(100).max(MCP_PAGE_TEXT_MAX_CHARS).optional(),
  maxNodes: z.number().int().min(1).max(2_000).optional(),
  interestingOnly: z.boolean().optional(),
  maxBytes: z.number().int().min(100_000).max(20_000_000).optional(),
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.number().int().min(30).max(100).optional(),
  includeScreenshot: z.boolean().optional(),
  include_screenshot: z.boolean().optional(),
  fullPage: z.boolean().optional(),
  full_page: z.boolean().optional(),
  full: z.boolean().optional(),
  maxDimension: z.number().int().min(100).max(20_000).optional(),
  max_dim: z.number().int().min(100).max(20_000).optional(),
  max_bytes: z.number().int().min(100_000).max(20_000_000).optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  pointerType: z.enum(["mouse", "touch"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  clear: z.boolean().optional(),
  append: z.boolean().optional(),
  verify: z.boolean().optional(),
  durationMs: z.number().int().min(0).max(30_000).optional(),
  pollMs: z.number().int().min(250).max(10_000).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
  optionValue: BoundedString(2_000).optional(),
  optionValues: z.array(BoundedString(2_000)).min(1).max(200).optional(),
  cookieName: BoundedString(256).optional(),
  cookieValue: z.string().max(20_000).optional(),
  cookieDomain: BoundedString(512).optional(),
  cookiePath: BoundedString(2_000).optional(),
  cookieSecure: z.boolean().optional(),
  cookieHttpOnly: z.boolean().optional(),
  storageArea: z.enum(["local", "session"]).optional(),
  storageKey: BoundedString(1_000).optional(),
  storageValue: z.string().max(20_000).optional(),
  storageAll: z.boolean().optional(),
  includeValues: z.boolean().optional(),
  confirmDestructive: z.boolean().optional(),
  revision: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict();

export const BrowserActionSchema = BrowserActionFieldsSchema.extend({ action: ActionNameSchema }).superRefine((input, context) => {
  const targetForms = [input.target !== undefined, input.ref !== undefined, input.selector !== undefined, input.index !== undefined].filter(Boolean).length;
  if (targetForms > 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one of target, ref, selector, or index." });
  }
  if (input.coordinateX !== undefined && input.coordinate_x !== undefined) {
    context.addIssue({ code: "custom", message: "Provide coordinateX or coordinate_x, not both." });
  }
  if (input.coordinateY !== undefined && input.coordinate_y !== undefined) {
    context.addIssue({ code: "custom", message: "Provide coordinateY or coordinate_y, not both." });
  }
  if (input.endCoordinateX !== undefined && input.end_coordinate_x !== undefined) {
    context.addIssue({ code: "custom", message: "Provide endCoordinateX or end_coordinate_x, not both." });
  }
  if (input.endCoordinateY !== undefined && input.end_coordinate_y !== undefined) {
    context.addIssue({ code: "custom", message: "Provide endCoordinateY or end_coordinate_y, not both." });
  }
  if (input.startCoordinateX !== undefined && input.start_coordinate_x !== undefined) {
    context.addIssue({ code: "custom", message: "Provide startCoordinateX or start_coordinate_x, not both." });
  }
  if (input.startCoordinateY !== undefined && input.start_coordinate_y !== undefined) {
    context.addIssue({ code: "custom", message: "Provide startCoordinateY or start_coordinate_y, not both." });
  }
  const hasEndX = input.endCoordinateX !== undefined || input.end_coordinate_x !== undefined;
  const hasEndY = input.endCoordinateY !== undefined || input.end_coordinate_y !== undefined;
  if (hasEndX !== hasEndY) {
    context.addIssue({ code: "custom", message: "endCoordinateX and endCoordinateY must be provided together." });
  }
  const hasStartX = input.startCoordinateX !== undefined || input.start_coordinate_x !== undefined;
  const hasStartY = input.startCoordinateY !== undefined || input.start_coordinate_y !== undefined;
  if (hasStartX !== hasStartY) {
    context.addIssue({ code: "custom", message: "startCoordinateX and startCoordinateY must be provided together." });
  }
  if (input.path !== undefined && (hasStartX || hasEndX)) {
    context.addIssue({ code: "custom", message: "Provide path or start/end coordinates, not both." });
  }
  if (input.newTab !== undefined && input.new_tab !== undefined) {
    context.addIssue({ code: "custom", message: "Provide newTab or new_tab, not both." });
  }
  if (input.includeScreenshot !== undefined && input.include_screenshot !== undefined) {
    context.addIssue({ code: "custom", message: "Provide includeScreenshot or include_screenshot, not both." });
  }
  if ([input.fullPage, input.full_page, input.full].filter((value) => value !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: "Provide only one of fullPage, full_page, or full." });
  }
  if (input.maxDimension !== undefined && input.max_dim !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxDimension or max_dim, not both." });
  }
  if (input.maxBytes !== undefined && input.max_bytes !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxBytes or max_bytes, not both." });
  }
  if (input.clear === true && input.append === true) {
    context.addIssue({ code: "custom", message: "Input clear and append cannot both be true." });
  }
  if (input.text !== undefined && input.value !== undefined && ["input", "wait_for_text", "find_text", "search_page", "alert_send_keys"].includes(input.action)) {
    context.addIssue({ code: "custom", message: "Provide text or value, not both." });
  }
  if (input.text !== undefined && input.query !== undefined && ["wait_for_text", "find_text", "search_page"].includes(input.action)) {
    context.addIssue({ code: "custom", message: "Provide text or query, not both." });
  }
  if (input.url !== undefined && input.value !== undefined && input.action === "wait_for_url") {
    context.addIssue({ code: "custom", message: "Provide url or value, not both." });
  }
  if (input.code !== undefined && input.expression !== undefined && input.action === "evaluate") {
    context.addIssue({ code: "custom", message: "Provide code or expression, not both." });
  }
  if (input.code === undefined && input.expression === undefined && input.action === "evaluate") {
    context.addIssue({ code: "custom", message: "Provide code or expression." });
  }
  if (input.script !== undefined && input.code !== undefined && input.action === "run_script") {
    context.addIssue({ code: "custom", message: "Provide script or code, not both." });
  }
  if (input.keys !== undefined && input.key !== undefined && input.action === "send_keys") {
    context.addIssue({ code: "custom", message: "Provide keys or key, not both." });
  }
  if (input.optionValue !== undefined && input.value !== undefined && input.action === "select_dropdown") {
    context.addIssue({ code: "custom", message: "Provide optionValue or value, not both." });
  }
  if (input.optionValue !== undefined && input.optionValues !== undefined && input.action === "select_dropdown") {
    context.addIssue({ code: "custom", message: "Provide optionValue or optionValues, not both." });
  }
  if (input.cookieValue !== undefined && input.value !== undefined && input.action === "set_cookie") {
    context.addIssue({ code: "custom", message: "Provide cookieValue or value, not both." });
  }
  if (input.storageValue !== undefined && input.value !== undefined && input.action === "set_storage") {
    context.addIssue({ code: "custom", message: "Provide storageValue or value, not both." });
  }
  if (input.outputPath !== undefined && input.filePath !== undefined && input.action === "save_as_pdf") {
    context.addIssue({ code: "custom", message: "Provide outputPath or filePath, not both." });
  }
  if (["navigate", "set_cookie"].includes(input.action) && input.url !== undefined && !isHttpUrl(input.url)) {
    context.addIssue({ code: "custom", message: "Navigation and cookie URLs must be absolute HTTP(S) URLs." });
  }
  if (input.action === "click") {
    const hasTarget = targetForms > 0;
    const hasX = input.coordinateX !== undefined || input.coordinate_x !== undefined;
    const hasY = input.coordinateY !== undefined || input.coordinate_y !== undefined;
    if (!hasTarget && !(hasX && hasY)) {
      context.addIssue({ code: "custom", message: "Provide target/index or both coordinateX and coordinateY." });
    }
    if (hasX !== hasY) {
      context.addIssue({ code: "custom", message: "coordinateX and coordinateY must be provided together." });
    }
    if (hasTarget && hasX) {
      context.addIssue({ code: "custom", message: "Provide either target/index or coordinates, not both." });
    }
  }
  if (input.action === "move") {
    const hasX = input.coordinateX !== undefined || input.coordinate_x !== undefined;
    const hasY = input.coordinateY !== undefined || input.coordinate_y !== undefined;
    if (!hasX || !hasY) {
      context.addIssue({ code: "custom", message: "Move requires coordinateX and coordinateY." });
    }
    if (targetForms > 0) {
      context.addIssue({ code: "custom", message: "Move accepts coordinates only." });
    }
  }

  const requireOne = (values: unknown[], message: string): void => {
    if (!values.some((value) => value !== undefined && value !== null)) {
      context.addIssue({ code: "custom", message });
    }
  };
  switch (input.action) {
    case "navigate":
      requireOne([input.url], "Navigate requires url.");
      break;
    case "input":
      requireOne([input.target, input.ref, input.selector, input.index], "Input requires target, ref, selector, or index.");
      requireOne([input.text, input.value], "Input requires text.");
      break;
    case "select_dropdown":
      requireOne([input.target, input.ref, input.selector, input.index], "Select requires target, ref, selector, or index.");
      requireOne([input.optionValue, input.optionValues, input.value], "Select requires optionValue or optionValues.");
      break;
    case "send_keys":
      requireOne([input.key, input.keys], "Keyboard input requires key or keys.");
      break;
    case "alert_send_keys":
      requireOne([input.text, input.value], "Dialog send_keys requires text.");
      break;
    case "switch_tab":
    case "close_tab":
      requireOne([input.pageId, input.target], `${input.action} requires pageId or target.`);
      break;
    case "wait_for_element":
    case "dropdown_options":
    case "find_elements":
    case "get_computed_style":
    case "hover":
    case "press_and_hold":
      requireOne([input.target, input.ref, input.selector, input.index], `${input.action} requires target, ref, selector, or index.`);
      break;
    case "wait_for_text":
    case "find_text":
      requireOne([input.text, input.query], `${input.action} requires text or query.`);
      break;
    case "wait_for_url":
      requireOne([input.url, input.value], "wait_for_url requires url.");
      break;
    case "upload_file":
      requireOne([input.target, input.ref, input.selector, input.index], "Upload requires target, ref, selector, or index.");
      requireOne([input.filePath], "Upload requires filePath.");
      break;
    case "save_as_pdf":
      requireOne([input.outputPath, input.filePath], "PDF export requires outputPath.");
      break;
    case "evaluate":
      requireOne([input.code, input.expression], "Evaluate requires code.");
      break;
    case "run_script":
      requireOne([input.script, input.code], "run_script requires a JSON action array.");
      break;
    case "set_cookie":
      requireOne([input.cookieName], "Cookie set requires cookieName.");
      break;
    case "delete_cookies":
      requireOne([input.cookieName], "Cookie delete requires cookieName.");
      break;
    case "set_storage":
      requireOne([input.storageKey], "Storage set requires storageKey.");
      break;
    case "clear_storage":
      if (input.storageKey === undefined && input.storageAll !== true) {
        context.addIssue({ code: "custom", message: "Storage clear requires storageKey or storageAll=true." });
      }
      if (input.storageKey !== undefined && input.storageAll === true) {
        context.addIssue({ code: "custom", message: "Storage clear accepts storageKey or storageAll=true, not both." });
      }
      break;
    default:
      break;
  }
});
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

const ACTION_ALIASES: Readonly<Record<string, string>> = {
  key: "send_keys",
  select: "select_dropdown",
  back: "go_back",
  forward: "go_forward",
  page_info: "get_page_info",
  challenge: "detect_challenge",
  interactive: "list_interactive",
  frames: "list_frames",
  downloads: "list_downloads",
  upload: "upload_file",
  pdf: "save_as_pdf",
};

const GROUPED_ACTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cookie: { get: "get_cookies", set: "set_cookie", delete: "delete_cookies" },
  cookies: { get: "get_cookies", set: "set_cookie", delete: "delete_cookies" },
  storage: { get: "get_storage", set: "set_storage", clear: "clear_storage" },
  dialog: { get_text: "alert_get_text", accept: "alert_accept", dismiss: "alert_dismiss", send_keys: "alert_send_keys" },
  network: { enable: "enable_network_log", disable: "disable_network_log", read: "get_network_log", clear: "clear_network_log", read_and_clear: "getclear_network_log" },
  network_log: { enable: "enable_network_log", disable: "disable_network_log", read: "get_network_log", clear: "clear_network_log", read_and_clear: "getclear_network_log" },
  console: { enable: "enable_console_log", disable: "disable_console_log", read: "get_console_log", clear: "clear_console_log", read_and_clear: "getclear_console_log" },
  console_log: { enable: "enable_console_log", disable: "disable_console_log", read: "get_console_log", clear: "clear_console_log", read_and_clear: "getclear_console_log" },
};

type NormalizationIssue = { fields: string[]; message: string };

function moveActionField(output: Record<string, unknown>, canonical: string, alias: string, issues: NormalizationIssue[]): void {
  const hasCanonical = Object.hasOwn(output, canonical);
  const hasAlias = Object.hasOwn(output, alias);
  if (hasCanonical && hasAlias) {
    issues.push({ fields: [canonical, alias], message: `Conflicting fields '${canonical}' and '${alias}' were provided.` });
    return;
  }
  if (hasAlias) {
    output[canonical] = output[alias];
    delete output[alias];
  }
}

/** Normalize standalone-style and grouped action inputs before canonical validation. */
function normalizeBrowserActionInput(value: unknown): { value: unknown; issues: NormalizationIssue[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, issues: [] };
  }
  const output = { ...(value as Record<string, unknown>) };
  const issues: NormalizationIssue[] = [];
  const rawAction = typeof output.action === "string" ? output.action : undefined;
  const grouped = rawAction ? GROUPED_ACTION_ALIASES[rawAction] : undefined;
  if (grouped) {
    const operation = typeof output.operation === "string" ? output.operation : "";
    const mappedAction = grouped[operation];
    if (mappedAction) {
      output.action = mappedAction;
      delete output.operation;
      if (rawAction === "cookie" || rawAction === "cookies") {
        moveActionField(output, "cookieName", "name", issues);
        moveActionField(output, "cookieValue", "value", issues);
        moveActionField(output, "cookieDomain", "domain", issues);
        moveActionField(output, "cookiePath", "path", issues);
        moveActionField(output, "cookieSecure", "secure", issues);
        moveActionField(output, "cookieHttpOnly", "httpOnly", issues);
      } else if (rawAction === "storage") {
        moveActionField(output, "storageArea", "area", issues);
        moveActionField(output, "storageKey", "key", issues);
        moveActionField(output, "storageValue", "value", issues);
        moveActionField(output, "storageAll", "all", issues);
      }
    }
  } else if (rawAction && ACTION_ALIASES[rawAction]) {
    output.action = ACTION_ALIASES[rawAction];
  }
  moveActionField(output, "pageId", "tab_id", issues);
  return { value: output, issues };
}

/** Input schema shared by browser_batch and browser_exec. Its output is always canonical. */
export const BrowserActionInputSchema = z.preprocess((value, context) => {
  const normalized = normalizeBrowserActionInput(value);
  for (const issue of normalized.issues) {
    context.addIssue({ code: "custom", path: issue.fields, message: issue.message });
  }
  return normalized.value;
}, BrowserActionSchema);

export type BrowserActionInput = z.infer<typeof BrowserActionInputSchema>;

export const SnapshotRequestSchema = z.object({
  pageId: BoundedString(200).optional(),
  frameId: BoundedString(200).optional(),
  includeFrames: z.enum(["none", "metadata"]).optional(),
  includeScreenshot: z.boolean().optional(),
  include_screenshot: z.boolean().optional(),
  fullPage: z.boolean().optional(),
  full_page: z.boolean().optional(),
  full: z.boolean().optional(),
  maxDimension: z.number().int().min(100).max(20_000).optional(),
  max_dim: z.number().int().min(100).max(20_000).optional(),
  maxChars: z.number().int().min(1_000).max(8_000).optional(),
}).strict().superRefine((input, context) => {
  if (input.includeScreenshot !== undefined && input.include_screenshot !== undefined) {
    context.addIssue({ code: "custom", message: "Provide includeScreenshot or include_screenshot, not both." });
  }
  if ([input.fullPage, input.full_page, input.full].filter((value) => value !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: "Provide only one of fullPage, full_page, or full." });
  }
  if (input.maxDimension !== undefined && input.max_dim !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxDimension or max_dim, not both." });
  }
});

export const NavigateRequestSchema = z.object({
  url: HttpUrl(8_000),
  pageId: BoundedString(200).optional(),
  includeSnapshot: z.boolean().optional(),
  newTab: z.boolean().optional(),
  new_tab: z.boolean().optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict().superRefine((input, context) => {
  if (input.newTab !== undefined && input.new_tab !== undefined) {
    context.addIssue({ code: "custom", message: "Provide newTab or new_tab, not both." });
  }
});

const ClickFieldsSchema = z.object({
  target: BoundedString(2_000).optional(),
  ref: z.string().trim().min(1).max(200).regex(/^(?:ref:)?e[1-9]\d*$/, "ref must be an element reference such as e5.").optional(),
  selector: BoundedString(2_000).optional(),
  index: z.number().int().min(0).max(1_000).optional(),
  coordinateX: z.number().finite().min(0).max(100_000).optional(),
  coordinateY: z.number().finite().min(0).max(100_000).optional(),
  coordinate_x: z.number().finite().min(0).max(100_000).optional(),
  coordinate_y: z.number().finite().min(0).max(100_000).optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  pointerType: z.enum(["mouse", "touch"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  newTab: z.boolean().optional(),
  new_tab: z.boolean().optional(),
  ...PageInput,
}).strict();

const ClickTargetFormSchema = z.union([
  ClickFieldsSchema.extend({ target: BoundedString(2_000) }),
  ClickFieldsSchema.extend({ ref: z.string().trim().min(1).max(200).regex(/^(?:ref:)?e[1-9]\d*$/, "ref must be an element reference such as e5.") }),
  ClickFieldsSchema.extend({ selector: BoundedString(2_000) }),
  ClickFieldsSchema.extend({ index: z.number().int().min(0).max(1_000) }),
  ClickFieldsSchema.extend({
    coordinateX: z.number().finite().min(0).max(100_000),
    coordinateY: z.number().finite().min(0).max(100_000),
  }),
  ClickFieldsSchema.extend({
    coordinate_x: z.number().finite().min(0).max(100_000),
    coordinate_y: z.number().finite().min(0).max(100_000),
  }),
]);

export const ClickRequestSchema = ClickTargetFormSchema.superRefine((input, context) => {
  const targetForms = [input.target !== undefined, input.ref !== undefined, input.selector !== undefined, input.index !== undefined].filter(Boolean).length;
  if (targetForms > 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one of target, selector, or index." });
  }
  const hasTarget = targetForms > 0;
  const hasX = input.coordinateX !== undefined || input.coordinate_x !== undefined;
  const hasY = input.coordinateY !== undefined || input.coordinate_y !== undefined;
  if (!hasTarget && !(hasX && hasY)) {
    context.addIssue({ code: "custom", message: "Provide target/index or both coordinateX and coordinateY." });
  }
  if (hasX !== hasY) {
    context.addIssue({ code: "custom", message: "coordinateX and coordinateY must be provided together." });
  }
  if (hasTarget && hasX) {
    context.addIssue({ code: "custom", message: "Provide either target/index or coordinates, not both." });
  }
  if (input.newTab !== undefined && input.new_tab !== undefined) {
    context.addIssue({ code: "custom", message: "Provide newTab or new_tab, not both." });
  }
  if (input.coordinateX !== undefined && input.coordinate_x !== undefined) {
    context.addIssue({ code: "custom", message: "Provide coordinateX or coordinate_x, not both." });
  }
  if (input.coordinateY !== undefined && input.coordinate_y !== undefined) {
    context.addIssue({ code: "custom", message: "Provide coordinateY or coordinate_y, not both." });
  }
});

const InputFieldsSchema = z.object({
  target: BoundedString(2_000).optional(),
  ref: z.string().trim().min(1).max(200).regex(/^(?:ref:)?e[1-9]\d*$/, "ref must be an element reference such as e5.").optional(),
  selector: BoundedString(2_000).optional(),
  index: z.number().int().min(0).max(1_000).optional(),
  text: z.string().max(20_000),
  clear: z.boolean().optional(),
  append: z.boolean().optional(),
  verify: z.boolean().optional(),
  ...PageInput,
}).strict();

const InputTargetFormSchema = z.union([
  InputFieldsSchema.extend({ target: BoundedString(2_000) }),
  InputFieldsSchema.extend({ ref: z.string().trim().min(1).max(200).regex(/^(?:ref:)?e[1-9]\d*$/, "ref must be an element reference such as e5.") }),
  InputFieldsSchema.extend({ selector: BoundedString(2_000) }),
  InputFieldsSchema.extend({ index: z.number().int().min(0).max(1_000) }),
]);

export const InputRequestSchema = InputTargetFormSchema.superRefine((input, context) => {
  const targetForms = [input.target !== undefined, input.ref !== undefined, input.selector !== undefined, input.index !== undefined].filter(Boolean).length;
  if (targetForms > 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one of target, ref, selector, or index." });
  }
  if (targetForms === 0) {
    context.addIssue({ code: "custom", message: "Provide target, ref, selector, or index." });
  }
  if (input.clear === true && input.append === true) {
    context.addIssue({ code: "custom", message: "Input clear and append cannot both be true." });
  }
});

const TargetFieldsSchema = z.object({ target: BoundedString(2_000).optional(), index: z.number().int().min(0).max(1_000).optional(), ...PageInput }).strict();
const TargetFormSchema = z.union([
  TargetFieldsSchema.extend({ target: BoundedString(2_000) }),
  TargetFieldsSchema.extend({ index: z.number().int().min(0).max(1_000) }),
]);

export const TargetRequestSchema = TargetFormSchema.superRefine((input, context) => {
  if (input.target !== undefined && input.index !== undefined) {
    context.addIssue({ code: "custom", message: "Provide target or index, not both." });
  }
  if (input.target === undefined && input.index === undefined) {
    context.addIssue({ code: "custom", message: "Provide target or index." });
  }
});
export const SelectorRequestSchema = z.object({ selector: BoundedString(2_000), ...PageInput }).strict();
export const WaitRequestSchema = z.object({ milliseconds: z.number().int().min(0).max(120_000).default(500), ...PageInput }).strict();
export const WaitForTextRequestSchema = z.object({ text: BoundedString(20_000), timeoutMs: z.number().int().min(100).max(120_000).optional(), ...PageInput }).strict();
export const WaitForUrlRequestSchema = z.object({ url: BoundedString(8_000), timeoutMs: z.number().int().min(100).max(120_000).optional(), ...PageInput }).strict();
export const WaitForHumanRequestSchema = z.object({ timeoutMs: z.number().int().min(500).max(600_000).optional(), pollMs: z.number().int().min(250).max(10_000).optional(), ...PageInput }).strict();
/**
 * Request a connected-AI challenge loop. The page id is optional because the
 * browser session may already have an active page; screenshot and evidence
 * bounds mirror the native snapshot/screenshot contracts.
 *
 * Aliases are retained for browser-use clients that use snake_case names. The
 * MCP handler normalizes them before dispatching the canonical action.
 */
export const SolveChallengeRequestSchema = z.object({
  pageId: BoundedString(200).optional(),
  includeScreenshot: z.boolean().optional(),
  include_screenshot: z.boolean().optional(),
  fullPage: z.boolean().optional(),
  full_page: z.boolean().optional(),
  full: z.boolean().optional(),
  maxDimension: z.number().int().min(1).max(20_000).optional(),
  max_dim: z.number().int().min(1).max(20_000).optional(),
  maxChars: z.number().int().min(1_000).max(MCP_PAGE_TEXT_MAX_CHARS).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((input, context) => {
  if (input.includeScreenshot !== undefined && input.include_screenshot !== undefined) {
    context.addIssue({ code: "custom", message: "Provide includeScreenshot or include_screenshot, not both." });
  }
  if ([input.fullPage, input.full_page, input.full].filter((value) => value !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: "Provide only one of fullPage, full_page, or full." });
  }
  if (input.maxDimension !== undefined && input.max_dim !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxDimension or max_dim, not both." });
  }
});
export const KeyRequestSchema = z.object({ keys: z.array(KeyboardString(100)).min(1).max(32), ...PageInput }).strict();
export const ScrollRequestSchema = z.object({ selector: BoundedString(2_000).optional(), direction: z.enum(["up", "down", "left", "right"]).default("down"), amount: z.number().finite().min(1).max(100_000).default(600), ...PageInput }).strict();
export const ScrollToBottomRequestSchema = z.object({ maxScrolls: z.number().int().min(1).max(50).optional(), timeoutMs: z.number().int().min(100).max(120_000).optional(), restoreTop: z.boolean().optional(), ...PageInput }).strict();
export const ExtractRequestSchema = z.object({ selector: BoundedString(2_000).optional(), query: BoundedString(4_000).optional(), includeLinks: z.boolean().optional(), offset: z.number().int().min(0).max(1_000_000).optional(), maxChars: z.number().int().min(100).max(8_000).optional(), ...PageInput }).strict().superRefine((input, context) => {
  if (input.selector !== undefined && input.query !== undefined) {
    context.addIssue({ code: "custom", message: "Provide selector or query, not both." });
  }
});
export const HtmlRequestSchema = z.object({ selector: BoundedString(2_000).optional(), maxChars: z.number().int().min(1_000).max(8_000).optional(), ...PageInput }).strict();
export const ScreenshotRequestSchema = z.object({ fullPage: z.boolean().optional(), full_page: z.boolean().optional(), full: z.boolean().optional(), maxBytes: z.number().int().min(100_000).max(20_000_000).optional(), max_bytes: z.number().int().min(100_000).max(20_000_000).optional(), maxDimension: z.number().int().min(1).max(20_000).optional(), max_dim: z.number().int().min(1).max(20_000).optional(), format: z.enum(["png", "jpeg"]).optional(), quality: z.number().int().min(30).max(100).optional(), ...PageInput }).strict().superRefine((input, context) => {
  if ([input.fullPage, input.full_page, input.full].filter((value) => value !== undefined).length > 1) {
    context.addIssue({ code: "custom", message: "Provide only one of fullPage, full_page, or full." });
  }
  if (input.maxBytes !== undefined && input.max_bytes !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxBytes or max_bytes, not both." });
  }
  if (input.maxDimension !== undefined && input.max_dim !== undefined) {
    context.addIssue({ code: "custom", message: "Provide maxDimension or max_dim, not both." });
  }
});
export const PdfRequestSchema = z.object({ outputPath: BoundedString(4_000), ...PageInput }).strict();
export const UploadRequestSchema = z.object({ selector: BoundedString(2_000), filePath: BoundedString(4_000), ...PageInput }).strict();
export const EvaluateRequestSchema = z.object({
  code: z.string().trim().min(1).max(40_000).optional(),
  expression: z.string().trim().min(1).max(40_000).optional(),
  ...PageInput,
}).strict().superRefine((input, context) => {
  if (input.code !== undefined && input.expression !== undefined) {
    context.addIssue({ code: "custom", message: "Provide code or expression, not both." });
  }
  if (input.code === undefined && input.expression === undefined) {
    context.addIssue({ code: "custom", message: "Provide code or expression." });
  }
});
export const NetworkLogRequestSchema = z.object({ operation: z.enum(["enable", "disable", "read", "clear", "read_and_clear"]), ...PageInput }).strict();
export const NetworkSearchRequestSchema = z.object({
  query: BoundedString(4_000).optional(),
  requestId: BoundedString(256).optional(),
  url: BoundedString(8_000).optional(),
  method: BoundedString(32).optional(),
  status: z.number().int().min(0).max(999).optional(),
  resourceType: BoundedString(64).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  pageId: BoundedString(200).optional(),
}).strict();
export const DialogRequestSchema = z.object({ operation: z.enum(["get_text", "accept", "dismiss", "send_keys"]), text: z.string().max(20_000).optional(), ...PageInput }).strict().superRefine((input, context) => {
  if (input.operation === "send_keys" && input.text === undefined) {
    context.addIssue({ code: "custom", message: "Dialog send_keys requires text." });
  }
  if (input.operation !== "send_keys" && input.text !== undefined) {
    context.addIssue({ code: "custom", message: `Dialog ${input.operation} does not accept text.` });
  }
});
export const CookieRequestSchema = z.object({
  operation: z.enum(["get", "set", "delete"]),
  name: BoundedString(256).optional(),
  value: z.string().max(20_000).optional(),
  domain: BoundedString(512).optional(),
  path: BoundedString(2_000).optional(),
  url: HttpUrl(8_000).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  ...PageInput,
}).strict().superRefine((input, context) => {
  if ((input.operation === "set" || input.operation === "delete") && !input.name) {
    context.addIssue({ code: "custom", message: `Cookie ${input.operation} requires name.` });
  }
  if (input.operation === "set" && input.value === undefined) {
    context.addIssue({ code: "custom", message: "Cookie set requires value." });
  }
});
export const StorageRequestSchema = z.object({
  operation: z.enum(["get", "set", "clear"]),
  area: z.enum(["local", "session"]).default("local"),
  key: BoundedString(1_000).optional(),
  value: z.string().max(20_000).optional(),
  all: z.boolean().optional(),
  includeValues: z.boolean().optional(),
  ...PageInput,
}).strict().superRefine((input, context) => {
  if (input.operation === "set" && !input.key) {
    context.addIssue({ code: "custom", message: "Storage set requires key." });
  }
  if (input.operation === "clear" && !input.key && input.all !== true) {
    context.addIssue({ code: "custom", message: "Storage clear requires key or all=true." });
  }
  if (input.operation === "clear" && input.key && input.all === true) {
    context.addIssue({ code: "custom", message: "Storage clear accepts key or all=true, not both." });
  }
});
export const BatchRequestSchema = z.object({
  actions: z.array(BrowserActionInputSchema).min(1).max(50).superRefine(validateActionPlan),
  confirmDestructive: z.boolean().optional(),
  includeSnapshot: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  if (!input.confirmDestructive && input.actions.some((action) => isDestructiveBatchAction(action.action))) {
    context.addIssue({ code: "custom", message: "This batch contains destructive actions. Set confirmDestructive=true to execute them." });
  }
});
export const ResearchRequestSchema = z.object({
  query: BoundedString(RESEARCH_QUERY_MAX_CHARS),
  maxResults: z.number().int().min(1).max(RESEARCH_MAX_RESULTS).optional(),
  maxChars: z.number().int().min(RESEARCH_MIN_CHARS).max(RESEARCH_MAX_CHARS).optional(),
}).strict();
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

function validateActionPlan(actions: Array<z.infer<typeof BrowserActionSchema>>, context: z.RefinementCtx): void {
  for (const [index, action] of actions.entries()) {
    if (action.action === "run_script") {
      context.addIssue({ code: "custom", path: [index], message: "Nested run_script actions are not allowed." });
    }
    if (action.action === "screenshot") {
      context.addIssue({ code: "custom", path: [index], message: "Screenshots must be requested with browser_screenshot so the image is returned as MCP image content." });
    }
    if (action.action === "close_browser" && index !== actions.length - 1) {
      context.addIssue({ code: "custom", path: [index], message: "close_browser must be the final action in a batch." });
    }
  }
}

export const BrowserActionPlanSchema = z.array(BrowserActionInputSchema).min(1).max(100).superRefine(validateActionPlan);

const DESTRUCTIVE_BATCH_ACTIONS = new Set<ActionName>([
  "close_tab",
  "close_browser",
  // PDF export atomically replaces an existing output path, so it is a
  // destructive write even though the browser page itself is not mutated.
  "save_as_pdf",
  "set_cookie",
  "delete_cookies",
  "set_storage",
  "clear_storage",
  "evaluate",
  "clear_network_log",
  "getclear_network_log",
  "clear_console_log",
  "getclear_console_log",
]);

export function isDestructiveBatchAction(action: ActionName): boolean {
  return DESTRUCTIVE_BATCH_ACTIONS.has(action);
}
