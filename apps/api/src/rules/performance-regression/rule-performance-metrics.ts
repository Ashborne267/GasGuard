/**
 * Metrics and structured logging for rule performance regression tracking (#1251).
 *
 * All metric labels are strictly bounded (ruleId, status, metric kind).
 * All structured logs are strictly sanitized to never include repository paths,
 * file contents, tokens, or raw exception strings.
 */

import {
  PerformanceRegressionStatus,
  RegressionMetricKind,
  RulePerformanceErrorCode,
} from "./rule-performance-types";

export interface RulePerformanceMetrics {
  incrementEvaluations(labels: { status: PerformanceRegressionStatus }): void;
  incrementBreaches(labels: {
    ruleId: string;
    metric: RegressionMetricKind;
    severity: "warning" | "breach";
  }): void;
  incrementErrors(labels: { code: RulePerformanceErrorCode }): void;
  observeEvaluationDuration(seconds: number): void;
  observeRuleDuration(labels: { ruleId: string }, seconds: number): void;
}

export class NoopRulePerformanceMetrics implements RulePerformanceMetrics {
  incrementEvaluations(): void {}
  incrementBreaches(): void {}
  incrementErrors(): void {}
  observeEvaluationDuration(): void {}
  observeRuleDuration(): void {}
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
  timestamp: string;
}

export interface RulePerformanceLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const DISALLOWED_KEY_PATTERNS = [
  /token/i,
  /key/i,
  /secret/i,
  /auth/i,
  /password/i,
  /credential/i,
  /path/i,
  /file/i,
  /code/i,
  /source/i,
];

export function sanitizeLogFields(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (DISALLOWED_KEY_PATTERNS.some((pattern) => pattern.test(k))) {
      continue;
    }
    if (v instanceof Error) {
      sanitized[k] = v.message;
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      sanitized[k] = sanitizeLogFields(v as Record<string, unknown>);
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

export class ConsoleRulePerformanceLogger implements RulePerformanceLogger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const sanitized = sanitizeLogFields(fields);
    const entry: LogEntry = {
      level,
      event,
      fields: sanitized,
      timestamp: new Date().toISOString(),
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
}
