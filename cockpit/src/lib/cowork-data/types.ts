// Type definitions for the Cowork Web Cockpit dashboard.
//
// These interfaces describe the shapes returned by the Cowork REST API
// (/api/cowork/*) and consumed by the React query hooks in
// `@/hooks/use-cowork-query`. They are intentionally data-free — every view
// must render real API data or a graceful empty state, never fabricated
// sample data.
//
// The API routes return **raw Prisma rows + a layer of legacy-field
// projections** (see the `projected = rows.map((x) => ({ ...x, <legacy>:
// <prismaField> }))` pattern in each route handler). Prisma's SQLite backend
// stores enums as `String` and nested values as JSON-encoded `String` (suffix
// `Json`) — those columns are typed as `string` here and must be parsed at the
// call site (see `stepsJson`, `manifestJson`, `dataJson`, `formDataJson`).
//
// The "legacy" fields kept below are the aliases the original sample-data
// views were written against. Each one is populated by an explicit projection
// in its API route — kept so older view code keeps compiling unchanged. The
// Prisma field is preferred for new code; the legacy alias is documented on
// each field with its source route.

export interface SampleTab {
  id: string;
  url: string;
  title: string;
  workspaceId: string | null;
 // Populated by `/api/cowork/tabs` projection (`t.workspace?.name ?? null`).
 // Prisma `Tab` has no `workspaceName` column — derive from the `workspace`
 // relation if you need it elsewhere.
  workspaceName: string | null;
 // Prisma: 'loading' | 'loaded' | 'crashed' | 'idle' (string-typed enum on
 // SQLite). Typed as `string` so any DB value round-trips.
  status: string;
  favIconUrl?: string | null;
 // Prisma field — preferred over the legacy `favIconUrl` alias.
  favicon?: string | null;
 // Prisma stores `lastAccessedAt: DateTime?`. `lastAccessed` is the legacy
 // alias projected by `/api/cowork/tabs` (mirrors `lastAccessedAt`).
  lastAccessed: number | string | Date | null;
  lastAccessedAt?: number | string | Date | null;
  active?: boolean;
 // Prisma boolean flags + legacy aliases projected by `/api/cowork/tabs`.
  isPinned?: boolean;
  isMuted?: boolean;
  pinned?: boolean;
  audiblyMuted?: boolean;
  webContentsId?: number | null;
  parentId?: string | null;
  groupId?: string | null;
  emoji?: string | null;
  emojiFlash?: boolean;
  partition?: string | null;
  loaderFlags?: string | null;
  source?: string | null;
  activeAt?: number | string | Date | null;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
}

export interface SampleWorkspace {
  id: string;
  name: string;
 // Populated by `/api/cowork/workspaces` projection (`ws.emoji`). Prisma
 // `Workspace` uses `emoji`, not `icon` — `icon` is the legacy alias.
  icon: string;
  emoji?: string;
  color?: string;
  order?: number;
  isDefault?: boolean;
 // Populated by `/api/cowork/workspaces` projection (`ws._count.tabs`).
 // Prisma `Workspace` has no `tabCount` column.
  tabCount: number;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
}

export interface SampleAgent {
 // Prisma `AgentTrust` model fields.
  id: string;
  agentId: string;
 // Prisma `name: String?` — nullable. Callers must guard with
 // `(a.name || "Unnamed")` before slicing/rendering.
  name: string | null;
  trustLevel: string;
  scope: string | null;
  grantedAt: number | string | Date;
  lastUsedAt: number | string | Date | null;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy aliases projected by `/api/cowork/agents` (sensible defaults — the
 // dashboard is read-only with no live run-state). `type` →
 // 'browser-extension'; `status` → 'idle'; `lastActive` → `lastUsedAt ??
 // grantedAt`; `currentTask` → null; `tasksCompleted` → 0.
  type: string;
  status: string;
  currentTask?: string | null;
  lastActive: number | string | Date | null;
  tasksCompleted: number;
}

export interface SampleTask {
 // Prisma `Task` model fields.
  id: string;
  agentId: string | null;
  tabId: string | null;
  title: string;
  description: string | null;
 // Prisma: 'pending' | 'running' | 'paused' | 'waiting-approval' |
 // 'ready-to-resume' | 'done' | 'failed' | 'cancelled' (string-typed enum).
  status: string;
 // JSON-encoded `TaskStep[]` (each step is `{ label: string; done: boolean }`).
 // Parse with `JSON.parse(t.stepsJson || "[]")` before accessing — the
 // raw value is a JSON string, NOT an array.
  stepsJson: string;
  currentStep: number;
  resultsJson: string;
  assignedTo: string | null;
  createdBy: string | null;
  completedAt: number | string | Date | null;
  createdAt: number | string | Date;
  updatedAt?: number | string | Date;
}

export interface SampleWorkflow {
  id: string;
  name: string;
  description: string | null;
 // JSON-encoded `WorkflowStep[]` (each step is an object — typically
 // `{ name?, action? }`). Parse with `JSON.parse(wf.stepsJson || "[]")`;
 // the raw value is a JSON string, NOT an array. Render defensively to
 // tolerate historical rows that may carry bare-string labels.
  stepsJson: string;
  variablesJson: string | null;
  isRecurring: boolean;
  scheduleCron: string | null;
  lastRunAt: number | string | Date | null;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy aliases projected by `/api/cowork/workflows`: `enabled` mirrors
 // `isRecurring`; `runs` is hardcoded `0` (no run log yet); `lastRun`
 // mirrors `lastRunAt`.
  enabled?: boolean;
  runs?: number;
  lastRun?: number | string | Date | null;
}

export interface SampleSecurityEvent {
 // Prisma `SecurityEvent` model fields.
  id: string;
 // type: 'prompt-injection' | 'script-injection' | 'network-block' |
 // 'secret-leak' | 'behavior-critical' | 'anomaly' | 'zero-day' |
 // 'exfiltration-attempt' | 'blocked' | 'warned' (string-typed enum).
  type: string;
 // severity: 'info' | 'low' | 'medium' | 'high' | 'critical'.
  severity: string;
  category?: string | null;
  action?: string | null;
  sourceUrl?: string | null;
  domain?: string | null;
  tabId?: string | null;
  details?: string | null;
  blocked: boolean;
  confidence?: number | null;
  falsePositive?: boolean | null;
  createdAt: number | string | Date;
 // Legacy aliases projected by `/api/cowork/security/events`: `timestamp`
 // mirrors `createdAt`; `description` mirrors `details ?? ''`.
  description?: string;
  timestamp: number | string | Date;
}

export interface SampleSession {
  id: string;
  name: string;
  partition: string;
  cookieStoreId?: string | null;
  isIncognito?: boolean;
  isDefault?: boolean;
  userAgent: string | null;
  createdAt: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy aliases projected by `/api/cowork/sessions`: `incognito` mirrors
 // `isIncognito`; `cookieCount` is hardcoded `0` (Prisma `Session` has no
 // cookie-count column — the dashboard can't derive one from the DB).
  incognito: boolean;
  cookieCount: number;
}

export interface SampleExtension {
 // Prisma `Extension` model fields.
  id: string;
  name: string;
  version: string;
  description: string | null;
 // Full manifest serialized as JSON. Parse with
 // `JSON.parse(ext.manifestJson || "{}")` to read `permissions`, `icons`,
 // etc. The Prisma model has NO `permissions` column — extracting from
 // `manifestJson` is the only correct path.
  manifestJson: string | null;
  isInstalled: boolean;
  isEnabled: boolean;
  source: string;
  trustLevel: string;
  createdAt: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy aliases projected by `/api/cowork/extensions`: `enabled` mirrors
 // `isEnabled`; `size` is hardcoded `0` (Prisma `Extension` has no size
 // column); `installedAt` mirrors `createdAt`. The Prisma model has NO
 // `permissions` or `manifest` field — parse `manifestJson` at the call
 // site instead.
  enabled?: boolean;
  size?: number;
  installedAt?: number | string | Date;
}

export interface SampleSiteMemoryEntry {
 // Prisma `SiteMemory` model fields.
  id: string;
  domain: string;
 // JSON-encoded `SiteData` (visits[], diffs[], stats). Parse with
 // `JSON.parse(e.dataJson || "{}")` to inspect structured memory. The
 // Prisma model has NO `key` or `value` columns.
  dataJson: string;
  version: number;
  capturedAt: number | string | Date;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
}

export interface SampleFormMemoryEntry {
 // Prisma `FormMemory` model fields.
  id: string;
  domain: string;
 // JSON-encoded `DomainFormData` (entries[]). Parse with
 // `JSON.parse(e.formDataJson || "{}")` to inspect form fields/values.
 // The Prisma model has NO `field`, `value`, or `formUrl` columns.
  formDataJson: string;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
}

export interface SampleMcpTool {
  name: string;
  description: string;
  category: string;
  readOnly: boolean;
}

export interface SampleBookmark {
  id: string;
 // Prisma `Bookmark.name`. The original sample-data layer used `title`;
 // `title` was removed because every view reads `name` directly (the
 // `BookmarkNode` component, the history list, etc.).
  name: string;
  url: string | null;
  type?: string;
  favicon?: string | null;
  parentId?: string | null;
  dateAdded?: number | string | Date;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
  children?: SampleBookmark[];
}

export interface SampleHistoryEntry {
  id: string;
  title: string;
  url: string;
  visitCount: number;
  firstVisitedAt?: number | string | Date;
  lastVisitedAt?: number | string | Date;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy alias projected by `/api/cowork/history`: `visitedAt` mirrors
 // `lastVisitedAt`. Kept because `collections-view`'s history-tab sort +
 // "visited N ago" renderer read `visitedAt` directly.
  visitedAt: number | string | Date;
}

export interface SamplePinboard {
  id: string;
  name: string;
  emoji: string;
  color?: string;
  layout?: string;
  background?: string;
  createdAt?: number | string | Date;
  updatedAt?: number | string | Date;
 // Legacy alias projected by `/api/cowork/pinboards`: `itemCount` mirrors
 // `_count.items` (Prisma `Pinboard` has no `itemCount` column — derived
 // from the `items` relation count via the `_count` include).
  itemCount: number;
}
