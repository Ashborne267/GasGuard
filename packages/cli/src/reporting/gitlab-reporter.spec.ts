import fs from "fs-extra";
import path from "path";
import os from "os";
import {
  generateGitLabFingerprint,
  generateGitLabReport,
  mapToGitLabSeverity,
  toGitLabCodeQualityReport,
} from "./gitlab-reporter";
import { Finding, ScanResult } from "./sarif-reporter";

describe("GitLab Reporter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasguard-gitlab-test-"));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const mockFinding: Finding = {
    file: "src/Vault.sol",
    line: 42,
    ruleId: "GAS-001",
    ruleName: "storage-caching",
    severity: "high",
    message: "State variable read multiple times in loop",
    suggestion: "Cache in memory variable before loop",
    gasSavings: 450,
    confidence: 0.95,
  };

  const mockScanResult: ScanResult = {
    timestamp: "2026-10-18T22:00:00Z",
    scanPath: "./src",
    totalFiles: 10,
    scannedFiles: 8,
    findings: [mockFinding],
    summary: {
      totalViolations: 1,
      bySeverity: {
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        info: 0,
      },
      byRule: {
        "GAS-001": 1,
      },
      totalGasSavings: 450,
    },
  };

  it("converts findings to GitLab Code Quality format", () => {
    const report = toGitLabCodeQualityReport([mockFinding]);
    expect(report).toHaveLength(1);

    const issue = report[0];
    expect(issue.check_name).toBe("GAS-001");
    expect(issue.description).toBe(
      "[GAS-001] storage-caching: State variable read multiple times in loop",
    );
    expect(issue.severity).toBe("major");
    expect(issue.location.path).toBe("src/Vault.sol");
    expect(issue.location.lines.begin).toBe(42);
    expect(issue.engine_name).toBe("GasGuard");
    expect(issue.categories).toContain("Gas Optimization");
    expect(issue.categories).toContain("Security");
    expect(issue.content?.body).toContain("Cache in memory");
    expect(issue.content?.body).toContain("450 units");
    expect(issue.content?.body).toContain("95%");
  });

  it("generates deterministic fingerprint for identical findings", () => {
    const fp1 = generateGitLabFingerprint(mockFinding);
    const fp2 = generateGitLabFingerprint({ ...mockFinding });
    expect(fp1).toBe(fp2);

    const fp3 = generateGitLabFingerprint({ ...mockFinding, line: 99 });
    expect(fp1).not.toBe(fp3);
  });

  it("maps severity levels according to GitLab specification", () => {
    expect(mapToGitLabSeverity("critical")).toBe("critical");
    expect(mapToGitLabSeverity("high")).toBe("major");
    expect(mapToGitLabSeverity("error")).toBe("major");
    expect(mapToGitLabSeverity("medium")).toBe("minor");
    expect(mapToGitLabSeverity("warning")).toBe("minor");
    expect(mapToGitLabSeverity("low")).toBe("info");
    expect(mapToGitLabSeverity("info")).toBe("info");
    expect(mapToGitLabSeverity("unknown")).toBe("info");
  });

  it("writes valid JSON report to disk", async () => {
    const outputFile = path.join(tmpDir, "gl-code-quality-report.json");
    await generateGitLabReport(mockScanResult, outputFile);

    const exists = await fs.pathExists(outputFile);
    expect(exists).toBe(true);

    const content = await fs.readJson(outputFile);
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0].check_name).toBe("GAS-001");
    expect(content[0].fingerprint).toBeDefined();
  });
});
