import { createHash } from "crypto";
import { RuleMatch, RuleSeverity } from "./sarif-formatter";

/**
 * Maps GasGuard rule matches into GitLab CI Code Quality JSON format
 * specification (https://docs.gitlab.com/ee/ci/testing/code_quality.html#implement-a-custom-tool).
 *
 * This allows GitLab CI pipelines to display findings directly in merge request
 * widgets and pipeline code quality tabs.
 */

export type GitLabSeverity = "info" | "minor" | "major" | "critical" | "blocker";

export interface GitLabCodeQualityLocation {
  path: string;
  lines: {
    begin: number;
    end?: number;
  };
}

export interface GitLabCodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: GitLabSeverity;
  location: GitLabCodeQualityLocation;
  categories?: string[];
  engine_name?: string;
  content?: {
    body: string;
  };
}

/**
 * Maps GasGuard RuleSeverity to GitLab Code Quality severity.
 */
export function toGitLabSeverity(severity: RuleSeverity): GitLabSeverity {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "major";
    case "medium":
      return "minor";
    case "low":
    case "info":
    default:
      return "info";
  }
}

/**
 * Generates a stable deterministic fingerprint (SHA-256 hex digest) for a match.
 */
export function computeGitLabFingerprint(match: RuleMatch): string {
  const normalizedFile = match.file.replace(/\\/g, "/");
  const payload = `${match.ruleId}:${normalizedFile}:${match.line}:${match.column ?? 0}:${match.message}`;
  return createHash("sha256").update(payload).digest("hex");
}

export interface GitLabFormatterOptions {
  engineName?: string;
  defaultCategory?: string;
}

/**
 * Transforms GasGuard rule matches to an array of GitLab Code Quality issues.
 */
export function toGitLabCodeQuality(
  matches: RuleMatch[],
  options: GitLabFormatterOptions = {},
): GitLabCodeQualityIssue[] {
  const engineName = options.engineName ?? "GasGuard";
  const defaultCategory = options.defaultCategory ?? "Gas Optimization";

  return matches.map((match) => {
    const description = match.ruleName
      ? `[${match.ruleId}] ${match.ruleName}: ${match.message}`
      : `[${match.ruleId}] ${match.message}`;

    const categories = [defaultCategory];
    if (match.severity === "critical" || match.severity === "high") {
      categories.push("Security");
    }

    const issue: GitLabCodeQualityIssue = {
      description,
      check_name: match.ruleId,
      fingerprint: computeGitLabFingerprint(match),
      severity: toGitLabSeverity(match.severity),
      location: {
        path: match.file.replace(/\\/g, "/"),
        lines: {
          begin: Math.max(1, match.line),
        },
      },
      categories,
      engine_name: engineName,
    };

    if (match.gasSavings !== undefined) {
      issue.content = {
        body: `Estimated potential gas savings: ${match.gasSavings} gas units.`,
      };
    }

    return issue;
  });
}

/**
 * Serializes GitLab Code Quality issues to a formatted JSON string.
 */
export function toGitLabCodeQualityString(
  matches: RuleMatch[],
  options: GitLabFormatterOptions = {},
): string {
  return `${JSON.stringify(toGitLabCodeQuality(matches, options), null, 2)}\n`;
}
