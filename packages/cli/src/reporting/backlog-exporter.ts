import { createHash } from "crypto";

export type BacklogFormat = "json" | "csv" | "markdown";

export interface BacklogItem {
  id: string;
  priority: number;
  status: "open";
  severity: string;
  ruleId: string;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  gasSavings?: number;
  confidence?: number;
}

export function createRemediationBacklog(report: unknown): BacklogItem[] {
  if (!isObject(report) || !Array.isArray(report.findings)) {
    throw new Error("Scan report must contain a findings array.");
  }

  return report.findings
    .map((finding, index) => toBacklogItem(finding, index))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.file.localeCompare(right.file) ||
        left.ruleId.localeCompare(right.ruleId) ||
        left.line - right.line,
    );
}

export function exportRemediationBacklog(
  backlog: BacklogItem[],
  format: BacklogFormat,
): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(backlog, null, 2)}\n`;
    case "csv":
      return formatCsv(backlog);
    case "markdown":
      return formatMarkdown(backlog);
    default:
      throw new Error(`Unsupported backlog format: ${String(format)}`);
  }
}

function toBacklogItem(value: unknown, index: number): BacklogItem {
  if (
    !isObject(value) ||
    typeof value.file !== "string" ||
    typeof value.ruleId !== "string" ||
    typeof value.severity !== "string" ||
    typeof value.message !== "string"
  ) {
    throw new Error(
      `Invalid finding at index ${index}: file, ruleId, severity, and message must be strings.`,
    );
  }

  const line = value.line === undefined ? 0 : value.line;
  if (!Number.isSafeInteger(line) || (line as number) < 0) {
    throw new Error(
      `Invalid finding at index ${index}: line must be a non-negative integer.`,
    );
  }
  if (value.gasSavings !== undefined && !isFiniteNumber(value.gasSavings)) {
    throw new Error(
      `Invalid finding at index ${index}: gasSavings must be finite.`,
    );
  }
  if (value.confidence !== undefined && !isFiniteNumber(value.confidence)) {
    throw new Error(
      `Invalid finding at index ${index}: confidence must be finite.`,
    );
  }

  const finding = value as Record<string, unknown>;
  const file = value.file;
  const ruleId = value.ruleId;
  const severity = value.severity;
  const message = value.message;
  const item: BacklogItem = {
    id: createHash("sha256")
      .update(JSON.stringify([file.replace(/\\/g, "/"), ruleId, line, message]))
      .digest("hex")
      .slice(0, 16),
    priority: severityPriority(severity),
    status: "open",
    severity,
    ruleId,
    file,
    line: line as number,
    message,
  };
  if (typeof finding.suggestion === "string")
    item.suggestion = finding.suggestion;
  if (typeof finding.gasSavings === "number")
    item.gasSavings = finding.gasSavings;
  if (typeof finding.confidence === "number")
    item.confidence = finding.confidence;
  return item;
}

function severityPriority(severity: string): number {
  const priorities: Record<string, number> = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
    info: 5,
  };
  return priorities[severity.toLowerCase()] ?? 6;
}

function formatCsv(backlog: BacklogItem[]): string {
  const headers = [
    "id",
    "priority",
    "status",
    "severity",
    "ruleId",
    "file",
    "line",
    "message",
    "suggestion",
    "gasSavings",
    "confidence",
  ];
  const rows = backlog.map((item) =>
    headers
      .map((header) => csvCell(item[header as keyof BacklogItem]))
      .join(","),
  );
  return `${[headers.join(","), ...rows].join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  let text = value === undefined ? "" : String(value);
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatMarkdown(backlog: BacklogItem[]): string {
  const headers = [
    "ID",
    "Priority",
    "Status",
    "Finding",
    "Rule",
    "Location",
    "Suggestion",
  ];
  const rows = backlog.map((item) => [
    item.id,
    String(item.priority),
    item.status,
    `${item.severity}: ${item.message}`,
    item.ruleId,
    `${item.file}:${item.line}`,
    item.suggestion ?? "",
  ]);
  const escape = (value: string) =>
    value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  return (
    [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
    ].join("\n") + "\n"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
