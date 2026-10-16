import {
  compareScanReports,
  formatComparisonText,
  parseScanReport,
} from "./comparison-reporter";

describe("scan report comparison", () => {
  const baseline = parseScanReport(
    {
      metadata: { timestamp: "2026-10-01T00:00:00.000Z" },
      findings: [
        {
          file: "contracts/A.sol",
          line: 10,
          ruleId: "SOL-001",
          severity: "high",
          message: "Avoid repeated storage reads",
        },
        {
          file: "contracts/B.sol",
          line: 4,
          ruleId: "SOL-002",
          severity: "medium",
          message: "Use unchecked arithmetic",
        },
      ],
    },
    "baseline",
  );

  it("reports added and resolved findings while ignoring line movement", () => {
    const current = parseScanReport(
      {
        metadata: { timestamp: "2026-10-15T00:00:00.000Z" },
        findings: [
          {
            file: "contracts/A.sol",
            line: 18,
            ruleId: "SOL-001",
            severity: "high",
            message: "Avoid repeated storage reads",
          },
          {
            file: "contracts/C.sol",
            line: 2,
            ruleId: "SOL-003",
            severity: "low",
            message: "Cache array length",
          },
        ],
      },
      "current",
    );
    const report = compareScanReports(baseline, current, new Date("2026-10-16T00:00:00Z"));

    expect(report.summary).toEqual({
      baselineFindings: 2,
      currentFindings: 2,
      added: 1,
      resolved: 1,
      netChange: 0,
    });
    expect(report.added[0].ruleId).toBe("SOL-003");
    expect(report.resolved[0].ruleId).toBe("SOL-002");
    expect(report.metadata).toEqual({
      version: 1,
      generatedAt: "2026-10-16T00:00:00.000Z",
      baselineTimestamp: "2026-10-01T00:00:00.000Z",
      currentTimestamp: "2026-10-15T00:00:00.000Z",
    });
    expect(formatComparisonText(report)).toContain("Net change: +0");
  });

  it("handles empty reports and rejects malformed report input", () => {
    const empty = parseScanReport({ findings: [] }, "empty");
    expect(compareScanReports(empty, empty).summary.netChange).toBe(0);
    expect(() => parseScanReport({ findings: {} }, "broken")).toThrow(
      "findings array",
    );
    expect(() =>
      parseScanReport({ findings: [{ file: "a.sol" }] }, "broken"),
    ).toThrow("invalid finding at index 0");
  });
});