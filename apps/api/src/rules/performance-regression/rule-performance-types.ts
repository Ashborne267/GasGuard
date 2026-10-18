/**
 * Shared types for rule performance regression thresholds tracking (#1251).
 *
 * Tracks execution duration, memory consumption, and error rates of rules across
 * repository scans and rule-pack versions. Flags performance regressions against
 * configured baseline thresholds, integrates with quality gates, and supports
 * tenant isolation, partial failure handling, and deterministic evaluation.
 */

export const PERFORMANCE_STATUSES = [
  "passed",
  "warning",
  "breached",
] as const;

export type PerformanceRegressionStatus = (typeof PERFORMANCE_STATUSES)[number];

export const REGRESSION_METRIC_KINDS = [
  "duration_ms",
  "memory_bytes",
  "error_rate",
] as const;

export type RegressionMetricKind = (typeof REGRESSION_METRIC_KINDS)[number];

export interface RulePerformanceThresholds {
  /** Maximum allowable absolute duration in ms before breach. */
  maxDurationMs?: number;
  /** Maximum allowable percentage increase in duration compared to baseline (e.g. 50 = +50%). */
  maxDurationDeltaPercent?: number;
  /** Maximum allowable absolute memory in bytes before breach. */
  maxMemoryBytes?: number;
  /** Maximum allowable percentage increase in memory compared to baseline. */
  maxMemoryDeltaPercent?: number;
  /** Maximum allowable error/timeout rate (0.0 - 1.0). */
  maxErrorRate?: number;
  /** Warning percentage factor (e.g. 0.8 means warning fires at 80% of threshold). Default: 0.8. */
  warningFactor?: number;
}

export interface RuleExecutionSample {
  ruleId: string;
  packId?: string;
  packVersion?: string;
  durationMs: number;
  memoryBytes?: number;
  status: "ok" | "error" | "timeout";
  findingsCount: number;
}

export interface RulePerformanceBaseline {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  ruleId: string;
  sampleCount: number;
  meanDurationMs: number;
  p95DurationMs: number;
  meanMemoryBytes: number;
  p95MemoryBytes: number;
  errorRate: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuleMetricBreach {
  metric: RegressionMetricKind;
  severity: "warning" | "breach";
  currentValue: number;
  baselineValue?: number;
  thresholdValue: number;
  deltaPercent?: number;
  message: string;
}

export interface RuleRegressionEvaluation {
  ruleId: string;
  status: PerformanceRegressionStatus;
  breaches: RuleMetricBreach[];
  currentDurationMs: number;
  baselineDurationMs?: number;
  currentMemoryBytes?: number;
  baselineMemoryBytes?: number;
  errorRate: number;
}

export interface EvaluationSummary {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  status: PerformanceRegressionStatus;
  totalRulesEvaluated: number;
  passedCount: number;
  warningCount: number;
  breachedCount: number;
  skippedRulesCount: number;
  ruleEvaluations: RuleRegressionEvaluation[];
  evaluatedAt: number;
  fingerprint: string;
}

export interface RegressionTrackingScanPin {
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  pinnedAt: number;
  baselineCommitHash?: string;
  fingerprint: string;
}

export type RulePerformanceErrorCode =
  | "TRACKING_DISABLED"
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "STORE_UNAVAILABLE"
  | "STORE_CONFLICT"
  | "UNSUPPORTED_REPOSITORY"
  | "BASELINE_NOT_FOUND";

export class RulePerformanceRegressionError extends Error {
  constructor(
    public readonly code: RulePerformanceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "RulePerformanceRegressionError";
  }
}
