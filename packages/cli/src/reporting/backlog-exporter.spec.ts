import {
  createRemediationBacklog,
  exportRemediationBacklog,
} from "./backlog-exporter";

describe("remediation backlog export", () => {
  it("orders findings by severity and exports CSV, JSON, and Markdown", () => {
    const backlog = createRemediationBacklog({
      findings: [
        {
          file: "src/B.sol",
          line: 8,
          ruleId: "SOL-LOW",
          severity: "low",
          message: "Low priority",
        },
        {
          file: "src/A.sol",
          line: 3,
          ruleId: "SOL-HIGH",
          severity: "high",
          message: "High priority",
          suggestion: "Cache this read",
        },
      ],
    });

    expect(backlog.map((item) => item.ruleId)).toEqual(["SOL-HIGH", "SOL-LOW"]);
    expect(backlog[0].status).toBe("open");
    expect(backlog[0].id).toMatch(/^[a-f0-9]{16}$/);
    expect(exportRemediationBacklog(backlog, "json")).toContain(
      '"status": "open"',
    );
    expect(exportRemediationBacklog(backlog, "csv")).toContain(
      "ruleId,file,line",
    );
    expect(exportRemediationBacklog(backlog, "markdown")).toContain(
      "High priority",
    );
  });

  it("supports empty reports and protects CSV cells from formula injection", () => {
    expect(createRemediationBacklog({ findings: [] })).toEqual([]);
    const backlog = createRemediationBacklog({
      findings: [
        {
          file: '=HYPERLINK("https://example.invalid")',
          line: 1,
          ruleId: "@SUM(A1:A2)",
          severity: "critical",
          message: "-1+1",
        },
      ],
    });
    const csv = exportRemediationBacklog(backlog, "csv");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'@SUM");
    expect(csv).toContain("'-1+1");
  });

  it("rejects malformed findings and invalid boundary values", () => {
    expect(() => createRemediationBacklog({})).toThrow("findings array");
    expect(() => createRemediationBacklog({ findings: [null] })).toThrow(
      "Invalid finding at index 0",
    );
    expect(() =>
      createRemediationBacklog({
        findings: [
          {
            file: "a.sol",
            ruleId: "R",
            severity: "high",
            message: "bad",
            line: -1,
          },
        ],
      }),
    ).toThrow("line must be a non-negative integer");
  });
});
