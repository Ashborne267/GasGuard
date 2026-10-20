/**
 * Service for tracking rule performance regression thresholds (#1251).
 *
 * Integrates with analyzer execution, worker scan jobs, and reporting APIs.
 * Supports tenant isolation, baseline creation, deterministic evaluation,
 * and resilient error handling for partial failures and retries.
 */

import {
  DEFAULT_RULE_PERFORMANCE_CONFIG,
  RulePerformanceConfig,
  resolveRulePerformanceConfig,
} from "./rule-performance-config";
import {
  evaluateRulePerformance,
  computeEvaluationFingerprint,
} from "./rule-performance-evaluator";
import {
  ConsoleRulePerformanceLogger,
  NoopRulePerformanceMetrics,
  RulePerformanceLogger,
  RulePerformanceMetrics,
} from "./rule-performance-metrics";
import {
  InMemoryRulePerformanceStore,
  RulePerformanceStore,
} from "./rule-performance-store";
import {
  EvaluationSummary,
  RegressionTrackingScanPin,
  RuleExecutionSample,
  RulePerformanceBaseline,
  RulePerformanceRegressionError,
  RulePerformanceThresholds,
} from "./rule-performance-types";

export interface RulePerformanceServiceOptions {
  store?: RulePerformanceStore;
  config?: Partial<RulePerformanceConfig>;
  logger?: RulePerformanceLogger;
  metrics?: RulePerformanceMetrics;
  clock?: () => number;
}

export interface TrackScanExecutionInput {
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  samples: RuleExecutionSample[];
  baselineCommitHash?: string;
}

export interface SetRuleBaselineInput {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  samples: RuleExecutionSample[];
}

export class RulePerformanceService {
  private readonly store: RulePerformanceStore;
  private readonly config: RulePerformanceConfig;
  private readonly logger: RulePerformanceLogger;
  private readonly metrics: RulePerformanceMetrics;
  private readonly clock: () => number;

  constructor(options: RulePerformanceServiceOptions = {}) {
    this.config = resolveRulePerformanceConfig(options.config || {});
    this.store = options.store || new InMemoryRulePerformanceStore();
    this.logger = options.logger || new ConsoleRulePerformanceLogger();
    this.metrics = options.metrics || new NoopRulePerformanceMetrics();
    this.clock = options.clock || (() => Date.now());
  }

  getConfig(): RulePerformanceConfig {
    return this.config;
  }

  /**
   * Pins a scan attempt or retrieves an existing pinned scan.
   * Ensures deterministic evaluation across scan retries.
   */
  async pinScan(input: {
    tenantId: string;
    scanId: string;
    repositoryId: string;
    commitHash: string;
    rulePackVersion: string;
    baselineCommitHash?: string;
  }): Promise<{ pin: RegressionTrackingScanPin; status: "created" | "reused" }> {
    this.validateIdentifier(input.tenantId, "tenantId");
    this.validateIdentifier(input.scanId, "scanId");
    this.validateIdentifier(input.repositoryId, "repositoryId");

    const existing = await this.store.getScanPin(input.tenantId, input.scanId);
    if (existing) {
      return { pin: existing, status: "reused" };
    }

    const fingerprint = computeEvaluationFingerprint(
      input.tenantId,
      input.repositoryId,
      input.commitHash,
      input.rulePackVersion,
      [],
    );

    const newPin: RegressionTrackingScanPin = {
      tenantId: input.tenantId,
      scanId: input.scanId,
      repositoryId: input.repositoryId,
      commitHash: input.commitHash,
      rulePackVersion: input.rulePackVersion,
      baselineCommitHash: input.baselineCommitHash,
      pinnedAt: this.clock(),
      fingerprint,
    };

    const saved = await this.store.saveScanPin(newPin);
    return { pin: saved, status: "created" };
  }

  /**
   * Evaluate rule execution performance against configured thresholds and stored baselines.
   */
  async evaluateScanPerformance(
    input: TrackScanExecutionInput,
  ): Promise<EvaluationSummary> {
    if (!this.config.enabled) {
      this.logger.info("Rule performance tracking is disabled via config");
      return {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        commitHash: input.commitHash,
        rulePackVersion: input.rulePackVersion,
        status: "passed",
        totalRulesEvaluated: 0,
        passedCount: 0,
        warningCount: 0,
        breachedCount: 0,
        skippedRulesCount: input.samples.length,
        ruleEvaluations: [],
        evaluatedAt: this.clock(),
        fingerprint: "disabled",
      };
    }

    this.validateIdentifier(input.tenantId, "tenantId");
    this.validateIdentifier(input.repositoryId, "repositoryId");
    this.validateIdentifier(input.scanId, "scanId");

    const startTs = this.clock();

    // Retrieve or establish scan pin for retries
    const { pin } = await this.pinScan({
      tenantId: input.tenantId,
      scanId: input.scanId,
      repositoryId: input.repositoryId,
      commitHash: input.commitHash,
      rulePackVersion: input.rulePackVersion,
      baselineCommitHash: input.baselineCommitHash,
    });

    const targetBaselineCommit = pin.baselineCommitHash || input.baselineCommitHash;

    // Load baselines
    const baselines = await this.store.getBaselinesForRepository(
      input.tenantId,
      input.repositoryId,
      targetBaselineCommit,
    );

    // Filter invalid or overflowing samples gracefully
    const validSamples = this.filterAndValidateSamples(input.samples);

    const summary = evaluateRulePerformance({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      commitHash: input.commitHash,
      rulePackVersion: input.rulePackVersion,
      samples: validSamples,
      baselines,
      defaultThresholds: this.config.defaultThresholds,
      ruleOverrides: this.config.ruleOverrides,
      clock: this.clock,
    });

    await this.store.saveEvaluation(summary);

    // Record metrics
    this.metrics.incrementEvaluations({ status: summary.status });
    for (const ruleEval of summary.ruleEvaluations) {
      this.metrics.observeRuleDuration(
        { ruleId: ruleEval.ruleId },
        ruleEval.currentDurationMs / 1000,
      );
      for (const breach of ruleEval.breaches) {
        this.metrics.incrementBreaches({
          ruleId: ruleEval.ruleId,
          metric: breach.metric,
          severity: breach.severity,
        });
      }
    }
    this.metrics.observeEvaluationDuration((this.clock() - startTs) / 1000);

    this.logger.info("Rule performance evaluation completed", {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      status: summary.status,
      breachedCount: summary.breachedCount,
      warningCount: summary.warningCount,
    });

    return summary;
  }

  /**
   * Save a set of execution samples as a new baseline for the given repo & commit.
   */
  async establishBaselines(input: SetRuleBaselineInput): Promise<number> {
    this.validateIdentifier(input.tenantId, "tenantId");
    this.validateIdentifier(input.repositoryId, "repositoryId");

    const samplesByRule = new Map<string, RuleExecutionSample[]>();
    for (const s of input.samples) {
      if (!samplesByRule.has(s.ruleId)) {
        samplesByRule.set(s.ruleId, []);
      }
      samplesByRule.get(s.ruleId)!.push(s);
    }

    let count = 0;
    const now = this.clock();

    for (const [ruleId, samples] of samplesByRule.entries()) {
      const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
      const meanDuration =
        durations.reduce((sum, d) => sum + d, 0) / durations.length;
      const p95Duration =
        durations[Math.min(Math.floor(durations.length * 0.95), durations.length - 1)];

      const memories = samples
        .map((s) => s.memoryBytes || 0)
        .sort((a, b) => a - b);
      const meanMemory =
        memories.reduce((sum, m) => sum + m, 0) / memories.length;
      const p95Memory =
        memories[Math.min(Math.floor(memories.length * 0.95), memories.length - 1)];

      const errors = samples.filter((s) => s.status !== "ok").length;
      const errorRate = errors / samples.length;

      const baseline: RulePerformanceBaseline = {
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        commitHash: input.commitHash,
        rulePackVersion: input.rulePackVersion,
        ruleId,
        sampleCount: samples.length,
        meanDurationMs: Math.round(meanDuration * 100) / 100,
        p95DurationMs: Math.round(p95Duration * 100) / 100,
        meanMemoryBytes: Math.round(meanMemory),
        p95MemoryBytes: Math.round(p95Memory),
        errorRate: Math.round(errorRate * 1000) / 1000,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.saveBaseline(baseline);
      count++;
    }

    this.logger.info("Rule performance baselines established", {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      baselinesCount: count,
    });

    return count;
  }

  private filterAndValidateSamples(
    samples: RuleExecutionSample[],
  ): RuleExecutionSample[] {
    const valid: RuleExecutionSample[] = [];
    for (const s of samples) {
      if (!s.ruleId || s.ruleId.trim() === "") continue;
      if (s.durationMs < 0 || !Number.isFinite(s.durationMs)) continue;
      if (s.memoryBytes !== undefined && s.memoryBytes < 0) continue;
      valid.push(s);
    }
    return valid.slice(0, this.config.maxSamplesPerRule * 100);
  }

  private validateIdentifier(value: string, field: string): void {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.length > this.config.maxIdentifierLength
    ) {
      throw new RulePerformanceRegressionError(
        "INVALID_INPUT",
        `${field} must be a non-empty string of at most ${this.config.maxIdentifierLength} characters`,
      );
    }
  }
}
