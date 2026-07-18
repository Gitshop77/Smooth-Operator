-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '📁',
    "color" TEXT NOT NULL DEFAULT '#4285f4',
    "order" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Tab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "favicon" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "webContentsId" INTEGER,
    "workspaceId" TEXT,
    "parentId" TEXT,
    "groupId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "emoji" TEXT,
    "emojiFlash" BOOLEAN NOT NULL DEFAULT false,
    "partition" TEXT,
    "loaderFlags" TEXT,
    "source" TEXT,
    "activeAt" DATETIME,
    "lastAccessedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tab_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "type" TEXT NOT NULL DEFAULT 'url',
    "favicon" TEXT,
    "parentId" TEXT,
    "dateAdded" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Bookmark_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Bookmark" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoryEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "visitCount" INTEGER NOT NULL DEFAULT 1,
    "firstVisitedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVisitedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "cookieStoreId" TEXT,
    "isIncognito" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "manifestJson" TEXT,
    "isInstalled" BOOLEAN NOT NULL DEFAULT true,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'local',
    "trustLevel" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabId" TEXT NOT NULL,
    "treeJson" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Snapshot_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "category" TEXT,
    "action" TEXT,
    "sourceUrl" TEXT,
    "domain" TEXT,
    "tabId" TEXT,
    "details" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "confidence" INTEGER,
    "falsePositive" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentTrust" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "name" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'T1',
    "scope" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT,
    "tabId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "resultsJson" TEXT NOT NULL DEFAULT '[]',
    "assignedTo" TEXT,
    "createdBy" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "variablesJson" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "scheduleCron" TEXT,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Pinboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '📌',
    "color" TEXT NOT NULL DEFAULT '#4285f4',
    "layout" TEXT NOT NULL DEFAULT 'default',
    "background" TEXT NOT NULL DEFAULT 'dark',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PinboardItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pinboardId" TEXT NOT NULL,
    "tabId" TEXT,
    "url" TEXT,
    "title" TEXT,
    "description" TEXT,
    "content" TEXT,
    "thumbnail" TEXT,
    "note" TEXT,
    "sourceUrl" TEXT,
    "type" TEXT NOT NULL DEFAULT 'link',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PinboardItem_pinboardId_fkey" FOREIGN KEY ("pinboardId") REFERENCES "Pinboard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FormMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "formDataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NetworkRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER,
    "mimeType" TEXT,
    "resourceType" TEXT,
    "requestBody" TEXT,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "errorText" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkRequest_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DevToolsLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tabId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'log',
    "message" TEXT NOT NULL,
    "argsJson" TEXT,
    "source" TEXT,
    "line" INTEGER,
    "column" INTEGER,
    "stackTrace" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DevToolsLog_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MCPToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "toolName" TEXT NOT NULL,
    "argsJson" TEXT,
    "resultJson" TEXT,
    "agentId" TEXT,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "tabId" TEXT,
    "agentId" TEXT,
    "summary" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityEvent_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "selector" TEXT,
    "diffMode" TEXT NOT NULL DEFAULT 'content',
    "intervalSec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFingerprint" TEXT,
    "lastHash" TEXT,
    "lastTitle" TEXT,
    "lastError" TEXT,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "lastChangeAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "tabId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchJob_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sessionId" TEXT,
    "agentId" TEXT,
    "tokensUsed" INTEGER,
    "model" TEXT,
    "toolCallsJson" TEXT,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Workspace_order_idx" ON "Workspace"("order");

-- CreateIndex
CREATE INDEX "Tab_url_idx" ON "Tab"("url");

-- CreateIndex
CREATE INDEX "Tab_workspaceId_idx" ON "Tab"("workspaceId");

-- CreateIndex
CREATE INDEX "Tab_groupId_idx" ON "Tab"("groupId");

-- CreateIndex
CREATE INDEX "Tab_lastAccessedAt_idx" ON "Tab"("lastAccessedAt");

-- CreateIndex
CREATE INDEX "Bookmark_url_idx" ON "Bookmark"("url");

-- CreateIndex
CREATE INDEX "Bookmark_parentId_idx" ON "Bookmark"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryEntry_url_key" ON "HistoryEntry"("url");

-- CreateIndex
CREATE INDEX "HistoryEntry_lastVisitedAt_idx" ON "HistoryEntry"("lastVisitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_name_key" ON "Session"("name");

-- CreateIndex
CREATE INDEX "Session_partition_idx" ON "Session"("partition");

-- CreateIndex
CREATE INDEX "Extension_name_idx" ON "Extension"("name");

-- CreateIndex
CREATE INDEX "Extension_source_idx" ON "Extension"("source");

-- CreateIndex
CREATE INDEX "Snapshot_tabId_idx" ON "Snapshot"("tabId");

-- CreateIndex
CREATE INDEX "Snapshot_capturedAt_idx" ON "Snapshot"("capturedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_type_idx" ON "SecurityEvent"("type");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_idx" ON "SecurityEvent"("severity");

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_domain_idx" ON "SecurityEvent"("domain");

-- CreateIndex
CREATE INDEX "AgentTrust_agentId_idx" ON "AgentTrust"("agentId");

-- CreateIndex
CREATE INDEX "AgentTrust_trustLevel_idx" ON "AgentTrust"("trustLevel");

-- CreateIndex
CREATE INDEX "Task_agentId_idx" ON "Task"("agentId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_tabId_idx" ON "Task"("tabId");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- CreateIndex
CREATE INDEX "Workflow_name_idx" ON "Workflow"("name");

-- CreateIndex
CREATE INDEX "Pinboard_name_idx" ON "Pinboard"("name");

-- CreateIndex
CREATE INDEX "PinboardItem_pinboardId_idx" ON "PinboardItem"("pinboardId");

-- CreateIndex
CREATE INDEX "PinboardItem_url_idx" ON "PinboardItem"("url");

-- CreateIndex
CREATE INDEX "SiteMemory_capturedAt_idx" ON "SiteMemory"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SiteMemory_domain_key" ON "SiteMemory"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "FormMemory_domain_key" ON "FormMemory"("domain");

-- CreateIndex
CREATE INDEX "NetworkRequest_tabId_idx" ON "NetworkRequest"("tabId");

-- CreateIndex
CREATE INDEX "NetworkRequest_url_idx" ON "NetworkRequest"("url");

-- CreateIndex
CREATE INDEX "NetworkRequest_timestamp_idx" ON "NetworkRequest"("timestamp");

-- CreateIndex
CREATE INDEX "DevToolsLog_tabId_idx" ON "DevToolsLog"("tabId");

-- CreateIndex
CREATE INDEX "DevToolsLog_level_idx" ON "DevToolsLog"("level");

-- CreateIndex
CREATE INDEX "DevToolsLog_timestamp_idx" ON "DevToolsLog"("timestamp");

-- CreateIndex
CREATE INDEX "MCPToolCall_toolName_idx" ON "MCPToolCall"("toolName");

-- CreateIndex
CREATE INDEX "MCPToolCall_agentId_idx" ON "MCPToolCall"("agentId");

-- CreateIndex
CREATE INDEX "MCPToolCall_sessionId_idx" ON "MCPToolCall"("sessionId");

-- CreateIndex
CREATE INDEX "MCPToolCall_createdAt_idx" ON "MCPToolCall"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_type_idx" ON "ActivityEvent"("type");

-- CreateIndex
CREATE INDEX "ActivityEvent_tabId_idx" ON "ActivityEvent"("tabId");

-- CreateIndex
CREATE INDEX "ActivityEvent_agentId_idx" ON "ActivityEvent"("agentId");

-- CreateIndex
CREATE INDEX "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "WatchJob_url_idx" ON "WatchJob"("url");

-- CreateIndex
CREATE INDEX "WatchJob_tabId_idx" ON "WatchJob"("tabId");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "ChatMessage_agentId_idx" ON "ChatMessage"("agentId");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_idx" ON "ChatMessage"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");
