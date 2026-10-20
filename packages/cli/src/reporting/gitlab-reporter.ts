import { createHash } from "crypto";
import * as fs from "fs-extra";
import * as path from "path";
import { Finding, ScanResult } from "./sarif-reporter";

export type GitLabSeverity = "info" | "minor" | "major" | "critical" | "blocker";

export interface GitLabCodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: GitLabSeverity;
  location: {
    path: string;
    lines: {
      begin: number;
      end?: number;
    };
  };
  categories?: string[];
  engine_name?: string;
  content?: {
    body: string;
  };
}

export interface GitLabReportOptions {
  engineName?: string;
  defaultCategory?: string;
}

/**
 * Maps finding severity string to GitLab Code Quality severity.
 */
export function mapToGitLabSeverity(severity: string): GitLabSeverity {
  const normalized = severity.toLowerCase();
  switch (normalized) {
    case "critical":
      return "critical";
    case "high":
    case "error":
      return "major";
    case "medium":
    case "warning":
    case "warn":
      return "minor";
    case "low":
    case "info":
    case "note":
    default:
      return "info";
  }
}

/**
 * Generates deterministic SHA-256 fingerprint for finding deduplication in GitLab.
 */
export function generateGitLabFingerprint(finding: Finding): string {
  const normalizedFile = finding.file.replace(/\\/g, "/");
  const payload = `${finding.ruleId}:${normalizedFile}:${finding.line}:${finding.message}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Converts GasGuard findings into GitLab Code Quality JSON schema objects.
 */
export function toGitLabCodeQualityReport(
  findings: Finding[],
  options: GitLabReportOptions = {},
): GitLabCodeQualityIssue[] {
  const engineName = options.engineName ?? "GasGuard";
  const defaultCategory = options.defaultCategory ?? "Gas Optimization";

  return findings.map((finding) => {
    const description = finding.ruleName
      ? `[${finding.ruleId}] ${finding.ruleName}: ${finding.message}`
      : `[${finding.ruleId}] ${finding.message}`;

    const categories = [defaultCategory];
    const sev = finding.severity.toLowerCase();
    if (sev === "critical" || sev === "high" || sev === "error") {
      categories.push("Security");
    }

    const issue: GitLabCodeQualityIssue = {
      description,
      check_name: finding.ruleId,
      fingerprint: generateGitLabFingerprint(finding),
      severity: mapToGitLabSeverity(finding.severity),
      location: {
        path: finding.file.replace(/\\/g, "/"),
        lines: {
          begin: Math.max(1, finding.line),
        },
      },
      categories,
      engine_name: engineName,
    };

    const details: string[] = [];
    if (finding.suggestion) {
      details.push(`Suggestion: ${finding.suggestion}`);
    }
    if (finding.gasSavings !== undefined) {
      details.push(`Estimated gas savings: ${finding.gasSavings} units`);
    }
    if (finding.confidence !== undefined) {
      details.push(`Confidence: ${(finding.confidence * 100).toFixed(0)}%`);
    }

    if (details.length > 0) {
      issue.content = {
        body: details.join(" | "),
      };
    }

    return issue;
  });
}

/**
 * Generates and writes GitLab Code Quality report to the given file path.
 */
export async function generateGitLabReport(
  scanResult: ScanResult,
  outputPath: string,
  options: GitLabReportOptions = {},
): Promise<void> {
  const report = toGitLabCodeQualityReport(scanResult.findings, options);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, report, { spaces: 2 });
}
