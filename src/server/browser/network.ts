import { redactSecretPlaceholders } from "../security";
import { sanitizeUrl } from "./utils";

/**
 * Values accepted for event timestamps. Browser adapters commonly expose an
 * ISO string, while test adapters and CDP wrappers may expose a Date or epoch
 * milliseconds.
 */
export type NetworkTimestamp = string | number | Date;

/** Metadata emitted when a browser request starts. */
export interface NetworkRequestEvent {
  pageId: string;
  requestId?: string | number;
  url: string;
  method: string;
  resourceType?: string;
  timestamp?: NetworkTimestamp;
}

/** Metadata emitted when a browser response is received. */
export interface NetworkResponseEvent {
  pageId: string;
  requestId: string | number;
  url?: string;
  status?: number;
  resourceType?: string;
  timestamp?: NetworkTimestamp;
}

/** A safe, correlated request/response metadata record. */
export interface NetworkJournalEntry {
  pageId: string;
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  requestTimestamp: string;
  responseTimestamp?: string;
}

/** Filters are case-insensitive substring matches except for status. */
export interface NetworkJournalFilter {
  pageId?: string;
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  resourceType?: string;
}

export interface NetworkJournalQuery extends NetworkJournalFilter {
  offset?: number;
  limit?: number;
}

export interface NetworkJournalSearchOptions extends NetworkJournalQuery {}

/** A deterministic bounded page of journal results. */
export interface NetworkJournalPage {
  entries: NetworkJournalEntry[];
  offset: number;
  limit: number;
  total: number;
  returnedCount: number;
  omittedCount: number;
  hasMore: boolean;
  /** Number of currently retained records across the selected page scope. */
  retainedCount: number;
  /** Maximum records retained for each page. */
  capacity: number;
  /** Cumulative records evicted by the fixed-capacity policy. */
  evictedCount: number;
  /** True when at least one selected page has reached its fixed capacity. */
  capacityReached: boolean;
}

export interface NetworkJournalOptions {
  /** Maximum records retained per page. Defaults to 500. */
  capacity?: number;
  /** Maximum page IDs retained by one journal. Defaults to 128. */
  maxPages?: number;
}

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 10_000;
const DEFAULT_MAX_PAGES = 128;
const MAX_MAX_PAGES = 1_024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGE_ID_CHARS = 200;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_METHOD_CHARS = 32;
const MAX_RESOURCE_TYPE_CHARS = 64;

interface StoredEntry {
  entry: NetworkJournalEntry;
  searchText: string;
}

interface PageJournal {
  entries: Map<string, StoredEntry>;
  evictedCount: number;
}

/**
 * A small in-memory request/response journal intended for browser page
 * listeners. It stores metadata only: headers, cookies, payloads, and bodies
 * are intentionally not accepted by the public event types and are ignored
 * when structurally compatible adapters pass extra fields at runtime.
 *
 * Records are kept in insertion order. Repeated request IDs update one record
 * rather than appending duplicates, allowing response events to correlate with
 * their request without changing result order. Each page has a fixed FIFO
 * capacity; the journal also bounds the number of page IDs it retains.
 */
export class NetworkJournal {
  readonly capacity: number;
  readonly maxPages: number;
  private readonly pages = new Map<string, PageJournal>();
  private generatedRequestSequence = 0;
  private evictedPageCount = 0;

  constructor(options: NetworkJournalOptions = {}) {
    this.capacity = boundedPositiveInteger(options.capacity ?? DEFAULT_CAPACITY, MAX_CAPACITY, "capacity");
    this.maxPages = boundedPositiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, MAX_MAX_PAGES, "maxPages");
  }

  /** Record or update request metadata and return an immutable snapshot. */
  recordRequest(event: NetworkRequestEvent): NetworkJournalEntry {
    const pageId = normalizeRequiredIdentifier(event?.pageId, "pageId", MAX_PAGE_ID_CHARS);
    const page = this.ensurePage(pageId);
    const requestId = this.resolveRequestId(pageId, event?.requestId);
    const existing = page.entries.get(requestId);
    const timestamp = normalizeTimestamp(event?.timestamp);
    const resourceType = normalizeOptionalText(event?.resourceType, MAX_RESOURCE_TYPE_CHARS) ?? existing?.entry.resourceType;
    const entry: NetworkJournalEntry = {
      pageId,
      requestId,
      url: safeNetworkUrl(event?.url),
      method: normalizeMethod(event?.method),
      ...(resourceType ? { resourceType } : {}),
      ...(existing?.entry.status !== undefined ? { status: existing.entry.status } : {}),
      requestTimestamp: existing?.entry.requestTimestamp ?? timestamp,
      ...(existing?.entry.responseTimestamp ? { responseTimestamp: existing.entry.responseTimestamp } : {}),
    };
    page.entries.set(requestId, this.stored(entry));
    this.enforcePageCapacity(page);
    return cloneEntry(page.entries.get(requestId)?.entry ?? entry);
  }

  /** Record or update response metadata and correlate it to its request. */
  recordResponse(event: NetworkResponseEvent): NetworkJournalEntry {
    const pageId = normalizeRequiredIdentifier(event?.pageId, "pageId", MAX_PAGE_ID_CHARS);
    const page = this.ensurePage(pageId);
    const requestId = normalizeRequiredIdentifier(event?.requestId, "requestId", MAX_REQUEST_ID_CHARS);
    const existing = page.entries.get(requestId);
    const timestamp = normalizeTimestamp(event?.timestamp);
    const entry: NetworkJournalEntry = existing
      ? {
        ...existing.entry,
        ...(event.url !== undefined ? { url: safeNetworkUrl(event.url) } : {}),
        ...(event.resourceType !== undefined ? { resourceType: normalizeOptionalText(event.resourceType, MAX_RESOURCE_TYPE_CHARS) } : {}),
        ...(isValidStatus(event.status) ? { status: event.status } : {}),
        responseTimestamp: timestamp,
      }
      : {
        pageId,
        requestId,
        url: event.url === undefined ? "[URL_UNAVAILABLE]" : safeNetworkUrl(event.url),
        method: "UNKNOWN",
        ...(normalizeOptionalText(event.resourceType, MAX_RESOURCE_TYPE_CHARS) ? { resourceType: normalizeOptionalText(event.resourceType, MAX_RESOURCE_TYPE_CHARS) } : {}),
        ...(isValidStatus(event.status) ? { status: event.status } : {}),
        requestTimestamp: timestamp,
        responseTimestamp: timestamp,
      };
    page.entries.set(requestId, this.stored(entry));
    this.enforcePageCapacity(page);
    return cloneEntry(page.entries.get(requestId)?.entry ?? entry);
  }

  /** Query retained records using deterministic metadata filters and paging. */
  query(query: NetworkJournalQuery = {}): NetworkJournalPage {
    const normalized = normalizeQuery(query);
    const selectedPages = normalized.pageId === undefined
      ? [...this.pages.entries()]
      : [[normalized.pageId, this.pages.get(normalized.pageId)] as const];
    const retainedCount = selectedPages.reduce((total, [, page]) => total + (page?.entries.size ?? 0), 0);
    const evictedCount = selectedPages.reduce((total, [, page]) => total + (page?.evictedCount ?? 0), 0) + (normalized.pageId === undefined ? this.evictedPageCount : 0);
    const capacityReached = selectedPages.some(([, page]) => (page?.entries.size ?? 0) >= this.capacity || (page?.evictedCount ?? 0) > 0);
    const matches: NetworkJournalEntry[] = [];
    for (const [, page] of selectedPages) {
      if (!page) continue;
      for (const stored of page.entries.values()) {
        if (matchesFilter(stored.entry, normalized)) {
          matches.push(stored.entry);
        }
      }
    }
    const entries = matches.slice(normalized.offset, normalized.offset + normalized.limit).map(cloneEntry);
    return {
      entries,
      offset: normalized.offset,
      limit: normalized.limit,
      total: matches.length,
      returnedCount: entries.length,
      omittedCount: Math.max(0, matches.length - entries.length),
      hasMore: normalized.offset + entries.length < matches.length,
      retainedCount,
      capacity: this.capacity,
      evictedCount,
      capacityReached,
    };
  }

  /** Search all safe metadata fields using one bounded case-insensitive scan. */
  search(searchText: string, options: NetworkJournalSearchOptions = {}): NetworkJournalPage {
    const query = normalizeSearchText(searchText);
    if (!query) {
      throw new RangeError("searchText must be a non-empty string.");
    }
    const normalized = normalizeQuery(options);
    const selectedPages = normalized.pageId === undefined
      ? [...this.pages.entries()]
      : [[normalized.pageId, this.pages.get(normalized.pageId)] as const];
    const matches: NetworkJournalEntry[] = [];
    for (const [, page] of selectedPages) {
      if (!page) continue;
      for (const stored of page.entries.values()) {
        if (stored.searchText.includes(query) && matchesFilter(stored.entry, normalized)) {
          matches.push(stored.entry);
        }
      }
    }
    return this.pageFromMatches(matches, normalized, selectedPages);
  }

  /** Remove all records, or only records associated with one page. */
  clear(pageId?: string): { clearedCount: number; retainedCount: number } {
    if (pageId === undefined) {
      const clearedCount = [...this.pages.values()].reduce((total, page) => total + page.entries.size, 0);
      this.pages.clear();
      this.evictedPageCount = 0;
      return { clearedCount, retainedCount: 0 };
    }
    const normalizedPageId = normalizeRequiredIdentifier(pageId, "pageId", MAX_PAGE_ID_CHARS);
    const page = this.pages.get(normalizedPageId);
    const clearedCount = page?.entries.size ?? 0;
    this.pages.delete(normalizedPageId);
    return { clearedCount, retainedCount: this.retainedCount() };
  }

  /** Return bounded journal counts without exposing records. */
  stats(pageId?: string): Pick<NetworkJournalPage, "retainedCount" | "capacity" | "evictedCount" | "capacityReached"> {
    const result = this.query(pageId === undefined ? {} : { pageId, limit: 1 });
    return {
      retainedCount: result.retainedCount,
      capacity: result.capacity,
      evictedCount: result.evictedCount,
      capacityReached: result.capacityReached,
    };
  }

  private pageFromMatches(matches: NetworkJournalEntry[], query: NormalizedQuery, selectedPages: ReadonlyArray<readonly [string, PageJournal | undefined]>): NetworkJournalPage {
    const entries = matches.slice(query.offset, query.offset + query.limit).map(cloneEntry);
    const retainedCount = selectedPages.reduce((total, [, page]) => total + (page?.entries.size ?? 0), 0);
    const evictedCount = selectedPages.reduce((total, [, page]) => total + (page?.evictedCount ?? 0), 0) + (query.pageId === undefined ? this.evictedPageCount : 0);
    return {
      entries,
      offset: query.offset,
      limit: query.limit,
      total: matches.length,
      returnedCount: entries.length,
      omittedCount: Math.max(0, matches.length - entries.length),
      hasMore: query.offset + entries.length < matches.length,
      retainedCount,
      capacity: this.capacity,
      evictedCount,
      capacityReached: selectedPages.some(([, page]) => (page?.entries.size ?? 0) >= this.capacity || (page?.evictedCount ?? 0) > 0),
    };
  }

  private ensurePage(pageId: string): PageJournal {
    const existing = this.pages.get(pageId);
    if (existing) return existing;
    while (this.pages.size >= this.maxPages) {
      const oldestPageId = this.pages.keys().next().value;
      if (oldestPageId === undefined) break;
      const oldest = this.pages.get(oldestPageId);
      this.evictedPageCount += (oldest?.entries.size ?? 0) + (oldest?.evictedCount ?? 0);
      this.pages.delete(oldestPageId);
    }
    const page: PageJournal = { entries: new Map(), evictedCount: 0 };
    this.pages.set(pageId, page);
    return page;
  }

  private resolveRequestId(pageId: string, rawRequestId: string | number | undefined): string {
    const normalized = normalizeOptionalIdentifier(rawRequestId, MAX_REQUEST_ID_CHARS);
    if (normalized) return normalized;
    this.generatedRequestSequence += 1;
    return `${pageId}:request-${this.generatedRequestSequence}`.slice(0, MAX_REQUEST_ID_CHARS);
  }

  private stored(entry: NetworkJournalEntry): StoredEntry {
    const searchParts = [entry.pageId, entry.requestId, entry.url, entry.method, entry.resourceType ?? "", entry.status === undefined ? "" : String(entry.status)];
    return { entry, searchText: searchParts.join(" ").toLocaleLowerCase("en-US") };
  }

  private enforcePageCapacity(page: PageJournal): void {
    while (page.entries.size > this.capacity) {
      const oldestRequestId = page.entries.keys().next().value;
      if (oldestRequestId === undefined) break;
      page.entries.delete(oldestRequestId);
      page.evictedCount += 1;
    }
  }

  private retainedCount(): number {
    return [...this.pages.values()].reduce((total, page) => total + page.entries.size, 0);
  }
}

interface NormalizedQuery extends NetworkJournalFilter {
  offset: number;
  limit: number;
}

function normalizeQuery(query: NetworkJournalQuery): NormalizedQuery {
  if (query === null || typeof query !== "object") {
    throw new TypeError("query must be an object.");
  }
  const offset = boundedNonnegativeInteger(query.offset ?? 0, "offset");
  const limit = boundedPositiveInteger(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT, "limit");
  return {
    ...(query.pageId === undefined ? {} : { pageId: normalizeRequiredIdentifier(query.pageId, "pageId", MAX_PAGE_ID_CHARS) }),
    ...(query.requestId === undefined ? {} : { requestId: normalizeOptionalText(query.requestId, MAX_REQUEST_ID_CHARS) }),
    ...(query.url === undefined ? {} : { url: normalizeSearchText(query.url) }),
    ...(query.method === undefined ? {} : { method: normalizeMethod(query.method) }),
    ...(query.status === undefined ? {} : { status: normalizeStatus(query.status) }),
    ...(query.resourceType === undefined ? {} : { resourceType: normalizeOptionalText(query.resourceType, MAX_RESOURCE_TYPE_CHARS) }),
    offset,
    limit,
  };
}

function matchesFilter(entry: NetworkJournalEntry, filter: NetworkJournalFilter): boolean {
  if (filter.pageId !== undefined && entry.pageId !== filter.pageId) return false;
  if (filter.requestId !== undefined && !entry.requestId.toLocaleLowerCase("en-US").includes(filter.requestId.toLocaleLowerCase("en-US"))) return false;
  if (filter.url !== undefined && !entry.url.toLocaleLowerCase("en-US").includes(filter.url.toLocaleLowerCase("en-US"))) return false;
  if (filter.method !== undefined && entry.method !== filter.method) return false;
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  if (filter.resourceType !== undefined && entry.resourceType?.toLocaleLowerCase("en-US") !== filter.resourceType.toLocaleLowerCase("en-US")) return false;
  return true;
}

function cloneEntry(entry: NetworkJournalEntry): NetworkJournalEntry {
  return { ...entry };
}

function safeNetworkUrl(rawUrl: string | undefined): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "[URL_UNAVAILABLE]";
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "[INVALID_URL]";
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return "[NON_HTTP_URL]";
  }
  return redactSecretPlaceholders(sanitizeUrl(trimmed));
}

function normalizeRequiredIdentifier(value: unknown, name: string, maxChars: number): string {
  const normalized = normalizeOptionalIdentifier(value, maxChars);
  if (!normalized) throw new TypeError(`${name} must be a non-empty string or number.`);
  return normalized;
}

function normalizeOptionalIdentifier(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  return normalizeOptionalText(String(value), maxChars);
}

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, "").trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function normalizeMethod(value: unknown): string {
  return (normalizeOptionalText(value, MAX_METHOD_CHARS) ?? "UNKNOWN").toUpperCase();
}

function normalizeSearchText(value: unknown): string {
  const normalized = normalizeOptionalText(value, 512);
  if (!normalized) throw new TypeError("search and filter values must be non-empty strings.");
  return normalized.toLocaleLowerCase("en-US");
}

function normalizeTimestamp(value: NetworkTimestamp | undefined): string {
  const date = value instanceof Date
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? new Date(value)
      : typeof value === "string" && value.trim()
        ? new Date(value)
        : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function isValidStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999;
}

function normalizeStatus(value: unknown): number {
  if (!isValidStatus(value)) throw new TypeError("status must be an integer between 0 and 999.");
  return value;
}

function boundedPositiveInteger(value: unknown, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function boundedNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return value;
}
