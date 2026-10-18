/**
 * Pure evaluation engine for rule performance regression thresholds (#1251).
 *
 * Deterministic: pure functions with no side-effects or system clock dependencies.
 * Given the same samples, baseline, and thresholds, results are 100% reproducible.
 */

import {
  EvaluationSummary,
  PerformanceRegressionStatus,
  RegressionMetricKind,
  RuleExecutionSample,
  RuleMetricBreach,
  RulePerformanceBaseline,
  RulePerformanceThresholds,
  RuleRegressionEvaluation,
} from "./rule-performance-types";

export interface EvaluationInput {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  samples: RuleExecutionSample[];
  baselines?: Map<string, RulePerformanceBaseline>;
  defaultThresholds: RulePerformanceThresholds;
  ruleOverrides?: Record<string, RulePerformanceThresholds>;
  clock?: () => number;
}

export function evaluateRulePerformance(
  input: EvaluationInput,
): EvaluationSummary {
  const {
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
    samples,
    baselines = new Map(),
    defaultThresholds,
    ruleOverrides = {},
    clock = () => Date.now(),
  } = input;

  // Group samples by ruleId
  const samplesByRule = new Map<string, RuleExecutionSample[]>();
  for (const sample of samples) {
    if (!samplesByRule.has(sample.ruleId)) {
      samplesByRule.set(sample.ruleId, []);
    }
    samplesByRule.get(sample.ruleId)!.push(sample);
  }

  // Sort rule IDs for deterministic iteration
  const sortedRuleIds = Array.from(samplesByRule.keys()).sort();

  const ruleEvaluations: RuleRegressionEvaluation[] = [];
  let passedCount = 0;
  let warningCount = 0;
  let breachedCount = 0;

  for (const ruleId of sortedRuleIds) {
    const ruleSamples = samplesByRule.get(ruleId)!;
    const baseline = baselines.get(ruleId);
    const thresholds = {
      ...defaultThresholds,
      ...(ruleOverrides[ruleId] || {}),
    };

    const evaluation = evaluateSingleRule(ruleId, ruleSamples, baseline, thresholds);
    ruleEvaluations.push(evaluation);

    if (evaluation.status === "breached") {
      breachedCount++;
    } else if (evaluation.status === "warning") {
      warningCount++;
    } else {
      passedCount++;
    }
  }

  const overallStatus: PerformanceRegressionStatus =
    breachedCount > 0 ? "breached" : warningCount > 0 ? "warning" : "passed";

  const fingerprint = computeEvaluationFingerprint(
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
    ruleEvaluations,
  );

  return {
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
    status: overallStatus,
    totalRulesEvaluated: sortedRuleIds.length,
    passedCount,
    warningCount,
    breachedCount,
    skippedRulesCount: 0,
    ruleEvaluations,
    evaluatedAt: clock(),
    fingerprint,
  };
}

export function evaluateSingleRule(
  ruleId: string,
  samples: RuleExecutionSample[],
  baseline: RulePerformanceBaseline | undefined,
  thresholds: RulePerformanceThresholds,
): RuleRegressionEvaluation {
  if (samples.length === 0) {
    return {
      ruleId,
      status: "passed",
      breaches: [],
      currentDurationMs: 0,
      baselineDurationMs: baseline?.meanDurationMs,
      currentMemoryBytes: 0,
      baselineMemoryBytes: baseline?.meanMemoryBytes,
      errorRate: 0,
    };
  }

  const totalDuration = samples.reduce((sum, s) => sum + s.durationMs, 0);
  const avgDuration = totalDuration / samples.length;

  const memorySamples = samples
    .map((s) => s.memoryBytes)
    .filter((m): m is number => m !== undefined && Number.isFinite(m));
  const avgMemory =
    memorySamples.length > 0
      ? memorySamples.reduce((sum, m) => sum + m, 0) / memorySamples.length
      : 0;

  const errorCount = samples.filter((s) => s.status !== "ok").length;
  const errorRate = errorCount / samples.length;

  const breaches: RuleMetricBreach[] = [];
  const warningFactor = thresholds.warningFactor ?? 0.8;

  // 1. Duration Absolute Threshold Check
  if (thresholds.maxDurationMs !== undefined) {
    checkMetricThreshold({
      metric: "duration_ms",
      currentValue: avgDuration,
      thresholdValue: thresholds.maxDurationMs,
      warningFactor,
      unit: "ms",
      ruleId,
      breaches,
    });
  }

  // 2. Duration Delta vs Baseline Check
  if (
    baseline &&
    baseline.meanDurationMs > 0 &&
    thresholds.maxDurationDeltaPercent !== undefined
  ) {
    const deltaPercent =
      ((avgDuration - baseline.meanDurationMs) / baseline.meanDurationMs) * 100;
    if (deltaPercent > 0) {
      checkDeltaThreshold({
        metric: "duration_ms",
        currentValue: avgDuration,
        baselineValue: baseline.meanDurationMs,
        deltaPercent,
        thresholdPercent: thresholds.maxDurationDeltaPercent,
        warningFactor,
        ruleId,
        breaches,
      });
    }
  }

  // 3. Memory Absolute Threshold Check
  if (avgMemory > 0 && thresholds.maxMemoryBytes !== undefined) {
    checkMetricThreshold({
      metric: "memory_bytes",
      currentValue: avgMemory,
      thresholdValue: thresholds.maxMemoryBytes,
      warningFactor,
      unit: "bytes",
      ruleId,
      breaches,
    });
  }

  // 4. Memory Delta vs Baseline Check
  if (
    baseline &&
    avgMemory > 0 &&
    baseline.meanMemoryBytes > 0 &&
    thresholds.maxMemoryDeltaPercent !== undefined
  ) {
    const deltaPercent =
      ((avgMemory - baseline.meanMemoryBytes) / baseline.meanMemoryBytes) * 100;
    if (deltaPercent > 0) {
      checkDeltaThreshold({
        metric: "memory_bytes",
        currentValue: avgMemory,
        baselineValue: baseline.meanMemoryBytes,
        deltaPercent,
        thresholdPercent: thresholds.maxMemoryDeltaPercent,
        warningFactor,
        ruleId,
        breaches,
      });
    }
  }

  // 5. Error Rate Threshold Check
  if (thresholds.maxErrorRate !== undefined) {
    checkMetricThreshold({
      metric: "error_rate",
      currentValue: errorRate,
      thresholdValue: thresholds.maxErrorRate,
      warningFactor,
      unit: "ratio",
      ruleId,
      breaches,
    });
  }

  const hasBreach = breaches.some((b) => b.severity === "breach");
  const hasWarning = breaches.some((b) => b.severity === "warning");

  const status: PerformanceRegressionStatus = hasBreach
    ? "breached"
    : hasWarning
      ? "warning"
      : "passed";

  return {
    ruleId,
    status,
    breaches,
    currentDurationMs: Math.round(avgDuration * 100) / 100,
    baselineDurationMs: baseline ? Math.round(baseline.meanDurationMs * 100) / 100 : undefined,
    currentMemoryBytes: avgMemory > 0 ? Math.round(avgMemory) : undefined,
    baselineMemoryBytes:
      baseline && baseline.meanMemoryBytes > 0
        ? Math.round(baseline.meanMemoryBytes)
        : undefined,
    errorRate: Math.round(errorRate * 1000) / 1000,
  };
}

function checkMetricThreshold(options: {
  metric: RegressionMetricKind;
  currentValue: number;
  thresholdValue: number;
  warningFactor: number;
  unit: string;
  ruleId: string;
  breaches: RuleMetricBreach[];
}): void {
  const { metric, currentValue, thresholdValue, warningFactor, unit, ruleId, breaches } =
    options;
  const warningThreshold = thresholdValue * warningFactor;

  if (currentValue >= thresholdValue) {
    breaches.push({
      metric,
      severity: "breach",
      currentValue: Math.round(currentValue * 100) / 100,
      thresholdValue,
      message: `Rule '${ruleId}' ${metric} (${roundVal(currentValue)}${unit}) breached threshold (${thresholdValue}${unit})`,
    });
  } else if (currentValue >= warningThreshold) {
    breaches.push({
      metric,
      severity: "warning",
      currentValue: Math.round(currentValue * 100) / 100,
      thresholdValue,
      message: `Rule '${ruleId}' ${metric} (${roundVal(currentValue)}${unit}) exceeded warning threshold (${roundVal(warningThreshold)}${unit})`,
    });
  }
}

function checkDeltaThreshold(options: {
  metric: RegressionMetricKind;
  currentValue: number;
  baselineValue: number;
  deltaPercent: number;
  thresholdPercent: number;
  warningFactor: number;
  ruleId: string;
  breaches: RuleMetricBreach[];
}): void {
  const {
    metric,
    currentValue,
    baselineValue,
    deltaPercent,
    thresholdPercent,
    warningFactor,
    ruleId,
    breaches,
  } = options;
  const warningPercent = thresholdPercent * warningFactor;

  if (deltaPercent >= thresholdPercent) {
    breaches.push({
      metric,
      severity: "breach",
      currentValue: Math.round(currentValue * 100) / 100,
      baselineValue: Math.round(baselineValue * 100) / 100,
      thresholdValue: thresholdPercent,
      deltaPercent: Math.round(deltaPercent * 10) / 10,
      message: `Rule '${ruleId}' ${metric} regressed by +${roundVal(deltaPercent)}% from baseline (${roundVal(baselineValue)} -> ${roundVal(currentValue)}), breaching threshold (+${thresholdPercent}%)`,
    });
  } else if (deltaPercent >= warningPercent) {
    breaches.push({
      metric,
      severity: "warning",
      currentValue: Math.round(currentValue * 100) / 100,
      baselineValue: Math.round(baselineValue * 100) / 100,
      thresholdValue: thresholdPercent,
      deltaPercent: Math.round(deltaPercent * 10) / 10,
      message: `Rule '${ruleId}' ${metric} regressed by +${roundVal(deltaPercent)}% from baseline, approaching warning limit (+${roundVal(warningPercent)}%)`,
    });
  }
}

function roundVal(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeEvaluationFingerprint(
  tenantId: string,
  repositoryId: string,
  commitHash: string,
  rulePackVersion: string,
  evaluations: RuleRegressionEvaluation[],
): string {
  const summary = evaluations
    .map((e) => `${e.ruleId}:${e.status}:${e.breaches.length}`)
    .sort()
    .join(",");
  const raw = `${tenantId}:${repositoryId}:${commitHash}:${rulePackVersion}:${summary}`;
  
  // Deterministic fast hash (djb2)
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
