import { describe, it, expect } from "vitest";
import {
  csvField,
  computeRange,
  deriveCostAnalytics,
  formatUsd,
  formatTokens,
  type CostUsageRecord,
} from "./cost-analytics";

const DAY_MS = 86_400_000;

describe("csvField", () => {
  it("prefixes formula-injection leading chars with a single quote", () => {
    expect(csvField("=cmd")).toBe("\"'=cmd\"");
    expect(csvField("+x")).toBe("\"'+x\"");
    expect(csvField("-x")).toBe("\"'-x\"");
    expect(csvField("@x")).toBe("\"'@x\"");
    expect(csvField("\tx")).toBe("\"'\tx\"");
    expect(csvField("\rx")).toBe("\"'\rx\"");
  });

  it("does not quote normal values", () => {
    expect(csvField("normal")).toBe("\"normal\"");
    expect(csvField(42)).toBe("\"42\"");
  });

  it("applies RFC-4180 quoting for commas and embedded quotes", () => {
    expect(csvField("a,b")).toBe("\"a,b\"");
    expect(csvField('q"x')).toBe("\"q\"\"x\"");
  });
});

describe("computeRange", () => {
  it("returns fixed day counts for preset ranges", () => {
    expect(computeRange("7d", "", "").rangeDays).toBe(7);
    expect(computeRange("30d", "", "").rangeDays).toBe(30);
    expect(computeRange("90d", "", "").rangeDays).toBe(90);
    expect(computeRange("7d", "", "").rangeError).toBeNull();
  });

  it("computes day math for a valid custom range", () => {
    const r = computeRange("custom", "2024-01-01", "2024-01-11");
    expect(r.rangeError).toBeNull();
    expect(r.rangeDays).toBe(10);
    expect(r.endMs).toBeGreaterThan(r.startMs);
  });

  it("rejects a start date after the end date", () => {
    const r = computeRange("custom", "2024-01-11", "2024-01-01");
    expect(r.rangeError).toBe("Start date must be on or before the end date.");
  });

  it("rejects unparseable custom dates", () => {
    const r = computeRange("custom", "not-a-date", "");
    expect(r.rangeError).toBe("Enter valid start and end dates.");
  });
});

describe("deriveCostAnalytics", () => {
  const day1 = new Date(2024, 0, 10, 0, 0, 0, 0).getTime();

  function rec(
    id: string,
    costUsd: number,
    tokensIn: number,
    tokensOut: number,
  ): CostUsageRecord {
    return {
      id,
      timestamp: day1 + 1000,
      agent: "a",
      model: "m",
      domain: "d",
      taskTitle: `task-${id}`,
      tokensIn,
      tokensOut,
      tokensReasoning: 0,
      tokensCached: 0,
      costUsd,
    };
  }

  it("returns zeros for empty input", () => {
    const a = deriveCostAnalytics([], 1, day1, day1 + DAY_MS - 1, false);
    expect(a.totalCost).toBe(0);
    expect(a.totalTokens).toBe(0);
    expect(a.tokensIn).toBe(0);
    expect(a.tokensOut).toBe(0);
    expect(a.daily.length).toBe(1);
    expect(a.topRuns).toEqual([]);
    expect(a.avgCostPerDay).toBe(0);
    expect(a.projectedMonthCost).toBe(0);
  });

  it("aggregates totals, breakdowns, and top runs", () => {
    const records = [rec("A", 10, 100, 50), rec("B", 5, 50, 25)];
    const a = deriveCostAnalytics(records, 1, day1, day1 + DAY_MS - 1, false);
    expect(a.totalCost).toBe(15);
    expect(a.totalTokens).toBe(225);
    expect(a.tokensIn).toBe(150);
    expect(a.tokensOut).toBe(75);
    expect(a.byAgent).toEqual([
      {
        key: "a",
        label: "a",
        cost: 15,
        tokens: 225,
        runs: 2,
        share: 1,
      },
    ]);
    expect(a.byModel[0].cost).toBe(15);
    expect(a.byDomain[0].key).toBe("d");
    expect(a.topRuns.map((r) => r.id)).toEqual(["A", "B"]);
    expect(a.avgCostPerDay).toBe(15);
    expect(a.projectedMonthCost).toBe(450);
  });
});

describe("formatUsd", () => {
  it("renders non-finite values as $0.00", () => {
    expect(formatUsd(NaN)).toBe("$0.00");
    expect(formatUsd(Infinity)).toBe("$0.00");
  });

  it("uses 4 decimals for tiny positive amounts below one cent", () => {
    expect(formatUsd(0.005)).toBe("$0.0050");
  });

  it("uses 2 decimals otherwise", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(1000)).toBe("$1000.00");
  });
});

describe("formatTokens", () => {
  it("formats millions with an M suffix", () => {
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatTokens(1500)).toBe("1.5K");
  });

  it("rounds and renders small counts as plain integers", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });
});
