/**
 * Worker-side adapter for rule performance regression tracking (#1251).
 *
 * Integrates directly with scan jobs, wrapping rule execution or analyzer runs.
 * Gathers timing and memory metrics safely, passes them to RulePerformanceService,
 * and handles partial failures and exceptions gracefully.
 */

import {
  RulePerformanceService,
  TrackScanExecutionInput,
} from "./rule-performance.service";
import {
  EvaluationSummary,
  RuleExecutionSample,
} from "./rule-performance-types";

export interface ScanWorkerRuleExecution {
  ruleId: string;
  packId?: string;
  packVersion?: string;
  execute: () => Promise<unknown[]> | unknown[];
}

export interface WorkerScanRuleExecutionOptions {
  service: RulePerformanceService;
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  baselineCommitHash?: string;
  failOnBreach?: boolean;
}

export async function runRulesWithPerformanceTracking(
  rules: ScanWorkerRuleExecution[],
  options: WorkerScanRuleExecutionOptions,
): Promise<{
  results: Map<string, unknown[]>;
  evaluation: EvaluationSummary;
}> {
  const {
    service,
    tenantId,
    scanId,
    repositoryId,
    commitHash,
    rulePackVersion,
    baselineCommitHash,
    failOnBreach = false,
  } = options;

  const results = new Map<string, unknown[]>();
  const samples: RuleExecutionSample[] = [];

  for (const rule of rules) {
    const startMemory = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
    const startTs = Date.now();
    let findings: unknown[] = [];
    let status: "ok" | "error" | "timeout" = "ok";

    try {
      findings = await rule.execute();
      results.set(rule.ruleId, findings);
    } catch (err) {
      status = "error";
      results.set(rule.ruleId, []);
    }

    const durationMs = Date.now() - startTs;
    const endMemory = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
    const memoryBytes = Math.max(0, endMemory - startMemory);

    samples.push({
      ruleId: rule.ruleId,
      packId: rule.packId,
      packVersion: rule.packVersion,
      durationMs,
      memoryBytes,
      status,
      findingsCount: findings.length,
    });
  }

  const evaluation = await service.evaluateScanPerformance({
    tenantId,
    scanId,
    repositoryId,
    commitHash,
    rulePackVersion,
    samples,
    baselineCommitHash,
  });

  if (failOnBreach && evaluation.status === "breached") {
    throw new Error(
      `Scan failed rule performance regression quality gate: ${evaluation.breachedCount} rule(s) breached thresholds.`,
    );
  }

  return { results, evaluation };
}
