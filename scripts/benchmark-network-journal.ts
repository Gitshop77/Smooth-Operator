import { NetworkJournal } from "../src/server/browser/network.js";

const CAPACITY = 500;
const RECORD_COUNT = 1_000;
const SECRET_QUERY_PREFIX = "query-secret-";

function durationMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoRawQuerySecret(value: unknown): void {
  assert(!JSON.stringify(value).includes(SECRET_QUERY_PREFIX), "The journal returned a raw query secret.");
}

function main(): void {
  const journal = new NetworkJournal({ capacity: CAPACITY });
  const insertStarted = process.hrtime.bigint();
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const requestId = `request-${String(index).padStart(4, "0")}`;
    const url = `https://example.test/api/${index}?token=${SECRET_QUERY_PREFIX}${index}`;
    journal.recordRequest({
      pageId: "benchmark-page",
      requestId,
      url,
      method: index % 2 === 0 ? "GET" : "POST",
      resourceType: index % 3 === 0 ? "Image" : "Script",
      timestamp: index,
    });
    journal.recordResponse({
      pageId: "benchmark-page",
      requestId,
      url,
      status: index % 2 === 0 ? 200 : 201,
      resourceType: index % 3 === 0 ? "Image" : "Script",
      timestamp: index + 1,
    });
  }
  const insertDurationMs = durationMs(insertStarted);

  const searchStarted = process.hrtime.bigint();
  const filtered = journal.query({ pageId: "benchmark-page", method: "GET", resourceType: "image", limit: 50, offset: 10 });
  const paginated = journal.query({ pageId: "benchmark-page", status: 201, limit: 25, offset: 25 });
  const searched = journal.search("request-0999", { pageId: "benchmark-page", limit: 10 });
  const searchDurationMs = durationMs(searchStarted);

  const stats = journal.stats("benchmark-page");
  assert(stats.retainedCount === CAPACITY, `Expected ${CAPACITY} retained records, got ${stats.retainedCount}.`);
  assert(stats.retainedCount <= CAPACITY, "The journal exceeded its configured capacity.");
  assert(stats.evictedCount === RECORD_COUNT - CAPACITY, `Expected ${RECORD_COUNT - CAPACITY} evictions, got ${stats.evictedCount}.`);
  assert(stats.capacityReached, "The journal did not report that capacity was reached.");
  assert(filtered.entries.length <= filtered.limit, "Filtered results exceeded their page limit.");
  assert(paginated.entries.length <= paginated.limit, "Paginated results exceeded their page limit.");
  assert(searched.entries.length === 1, "The representative request search did not return one record.");
  assertNoRawQuerySecret(filtered);
  assertNoRawQuerySecret(paginated);
  assertNoRawQuerySecret(searched);

  process.stdout.write(`${JSON.stringify({
    benchmark: "network-journal",
    eventCalls: RECORD_COUNT * 2,
    correlatedRecords: RECORD_COUNT,
    insertDurationMs: Number(insertDurationMs.toFixed(3)),
    searchDurationMs: Number(searchDurationMs.toFixed(3)),
    capacity: stats.capacity,
    retainedCount: stats.retainedCount,
    evictedCount: stats.evictedCount,
    capacityReached: stats.capacityReached,
    searches: {
      filtered: { total: filtered.total, returnedCount: filtered.returnedCount, offset: filtered.offset, limit: filtered.limit },
      paginated: { total: paginated.total, returnedCount: paginated.returnedCount, offset: paginated.offset, limit: paginated.limit },
      requestId: { total: searched.total, returnedCount: searched.returnedCount, offset: searched.offset, limit: searched.limit },
    },
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
