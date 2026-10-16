export interface ComparableFinding {
  file: string;
  line?: number;
  ruleId: string;
  severity: string;
  message: string;
  [key: string]: unknown;
}

export interface ScanReportInput {
  metadata?: { timestamp?: string };
  findings: ComparableFinding[];
}

export interface ComparisonReport {
  metadata: {
    version: 1;
    generatedAt: string;
    baselineTimestamp?: string;
    currentTimestamp?: string;
  };
  summary: {
    baselineFindings: number;
    currentFindings: number;
    added: number;
    resolved: number;
    netChange: number;
  };
  added: ComparableFinding[];
  resolved: ComparableFinding[];
}

export function parseScanReport(value: unknown, source: string): ScanReportInput {
  if (!isObject(value) || !Array.isArray(value.findings)) {
    throw new Error(`${source} must be a GasGuard JSON report with a findings array.`);
  }

  const findings = value.findings.map((finding, index) => {
    if (
      !isObject(finding) ||
      typeof finding.file !== "string" ||
      typeof finding.ruleId !== "string" ||
      typeof finding.severity !== "string" ||
      typeof finding.message !== "string"
    ) {
      throw new Error(
        `${source} contains an invalid finding at index ${index}; file, ruleId, severity, and message must be strings.`,
      );
    }
    return finding as ComparableFinding;
  });

  const metadata = isObject(value.metadata) ? value.metadata : undefined;
  return {
    findings,
    metadata:
      metadata && typeof metadata.timestamp === "string"
        ? { timestamp: metadata.timestamp }
        : undefined,
  };
}

export function compareScanReports(
  baseline: ScanReportInput,
  current: ScanReportInput,
  generatedAt: Date = new Date(),
): ComparisonReport {
  const unmatchedBaseline = new Map<string, ComparableFinding[]>();
  for (const finding of baseline.findings) {
    const key = findingKey(finding);
    const matches = unmatchedBaseline.get(key) ?? [];
    matches.push(finding);
    unmatchedBaseline.set(key, matches);
  }

  const added: ComparableFinding[] = [];
  for (const finding of current.findings) {
    const matches = unmatchedBaseline.get(findingKey(finding));
    if (matches?.length) {
      matches.shift();
    } else {
      added.push(finding);
    }
  }
  const resolved = [...unmatchedBaseline.values()].flat();

  return {
    metadata: {
      version: 1,
      generatedAt: generatedAt.toISOString(),
      baselineTimestamp: baseline.metadata?.timestamp,
      currentTimestamp: current.metadata?.timestamp,
    },
    summary: {
      baselineFindings: baseline.findings.length,
      currentFindings: current.findings.length,
      added: added.length,
      resolved: resolved.length,
      netChange: added.length - resolved.length,
    },
    added,
    resolved,
  };
}

export function formatComparisonText(report: ComparisonReport): string {
  const lines = [
    `Baseline findings: ${report.summary.baselineFindings}`,
    `Current findings: ${report.summary.currentFindings}`,
    `Added: ${report.summary.added}`,
    `Resolved: ${report.summary.resolved}`,
    `Net change: ${report.summary.netChange >= 0 ? "+" : ""}${report.summary.netChange}`,
  ];
  for (const finding of report.added) {
    lines.push(`+ ${finding.file}:${finding.line ?? 0} [${finding.severity}] ${finding.ruleId} - ${finding.message}`);
  }
  for (const finding of report.resolved) {
    lines.push(`- ${finding.file}:${finding.line ?? 0} [${finding.severity}] ${finding.ruleId} - ${finding.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function findingKey(finding: ComparableFinding): string {
  return JSON.stringify([
    finding.file.replace(/\\/g, "/"),
    finding.ruleId,
    finding.severity,
    finding.message,
  ]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}