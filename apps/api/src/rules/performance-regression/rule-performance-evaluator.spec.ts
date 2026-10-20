import {
  evaluateRulePerformance,
  evaluateSingleRule,
  computeEvaluationFingerprint,
} from "./rule-performance-evaluator";
import {
  RuleExecutionSample,
  RulePerformanceBaseline,
  RulePerformanceThresholds,
} from "./rule-performance-types";

describe("RulePerformanceEvaluator", () => {
  const defaultThresholds: RulePerformanceThresholds = {
    maxDurationMs: 1000,
    maxDurationDeltaPercent: 50,
    maxMemoryBytes: 1000000,
    maxMemoryDeltaPercent: 50,
    maxErrorRate: 0.1,
    warningFactor: 0.8,
  };

  const sampleBaseline: RulePerformanceBaseline = {
    tenantId: "tenant-1",
    repositoryId: "repo-1",
    commitHash: "c001",
    rulePackVersion: "1.0.0",
    ruleId: "rule-a",
    sampleCount: 10,
    meanDurationMs: 200,
    p95DurationMs: 250,
    meanMemoryBytes: 200000,
    p95MemoryBytes: 250000,
    errorRate: 0,
    createdAt: 1000,
    updatedAt: 1000,
  };

  it("evaluates a rule as passed when metrics are well within limits", () => {
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-a", durationMs: 210, memoryBytes: 210000, status: "ok", findingsCount: 0 },
      { ruleId: "rule-a", durationMs: 200, memoryBytes: 205000, status: "ok", findingsCount: 0 },
    ];

    const result = evaluateSingleRule("rule-a", samples, sampleBaseline, defaultThresholds);
    expect(result.status).toBe("passed");
    expect(result.breaches).toHaveLength(0);
    expect(result.currentDurationMs).toBe(205);
  });

  it("detects a warning when duration approaches threshold", () => {
    // 850ms is >= warning threshold (800ms) but < maxDurationMs (1000ms)
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-standalone", durationMs: 850, status: "ok", findingsCount: 0 },
    ];

    const result = evaluateSingleRule("rule-standalone", samples, undefined, defaultThresholds);
    expect(result.status).toBe("warning");
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0].severity).toBe("warning");
    expect(result.breaches[0].metric).toBe("duration_ms");
  });

  it("detects a breach when duration exceeds absolute threshold", () => {
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-standalone", durationMs: 1200, status: "ok", findingsCount: 0 },
    ];

    const result = evaluateSingleRule("rule-standalone", samples, undefined, defaultThresholds);
    expect(result.status).toBe("breached");
    expect(result.breaches[0].severity).toBe("breach");
  });

  it("detects a regression breach when duration increases by > 50% from baseline", () => {
    // Baseline meanDurationMs is 200ms. 350ms is a +75% regression.
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-a", durationMs: 350, memoryBytes: 200000, status: "ok", findingsCount: 0 },
    ];

    const result = evaluateSingleRule("rule-a", samples, sampleBaseline, defaultThresholds);
    expect(result.status).toBe("breached");
    const deltaBreach = result.breaches.find((b) => b.deltaPercent !== undefined);
    expect(deltaBreach).toBeDefined();
    expect(deltaBreach?.deltaPercent).toBe(75);
    expect(deltaBreach?.severity).toBe("breach");
  });

  it("detects memory regression when memory consumption increases", () => {
    // Baseline meanMemory is 200,000 bytes. 360,000 bytes is +80%.
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-a", durationMs: 200, memoryBytes: 360000, status: "ok", findingsCount: 0 },
    ];

    const result = evaluateSingleRule("rule-a", samples, sampleBaseline, defaultThresholds);
    expect(result.status).toBe("breached");
    const memBreach = result.breaches.find((b) => b.metric === "memory_bytes");
    expect(memBreach).toBeDefined();
    expect(memBreach?.severity).toBe("breach");
  });

  it("detects error rate breach", () => {
    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-flaky", durationMs: 100, status: "error", findingsCount: 0 },
      { ruleId: "rule-flaky", durationMs: 100, status: "ok", findingsCount: 0 },
    ]; // 50% error rate > 10% threshold

    const result = evaluateSingleRule("rule-flaky", samples, undefined, defaultThresholds);
    expect(result.status).toBe("breached");
    expect(result.errorRate).toBe(0.5);
  });

  it("computes overall evaluation summary deterministically", () => {
    const baselines = new Map<string, RulePerformanceBaseline>();
    baselines.set("rule-a", sampleBaseline);

    const samples: RuleExecutionSample[] = [
      { ruleId: "rule-a", durationMs: 200, memoryBytes: 200000, status: "ok", findingsCount: 0 },
      { ruleId: "rule-b", durationMs: 1500, status: "ok", findingsCount: 0 }, // breached
    ];

    const summary1 = evaluateRulePerformance({
      tenantId: "tenant-1",
      repositoryId: "repo-1",
      commitHash: "commit-xyz",
      rulePackVersion: "1.0.0",
      samples,
      baselines,
      defaultThresholds,
      clock: () => 1234567890,
    });

    const summary2 = evaluateRulePerformance({
      tenantId: "tenant-1",
      repositoryId: "repo-1",
      commitHash: "commit-xyz",
      rulePackVersion: "1.0.0",
      samples,
      baselines,
      defaultThresholds,
      clock: () => 1234567890,
    });

    expect(summary1.status).toBe("breached");
    expect(summary1.totalRulesEvaluated).toBe(2);
    expect(summary1.breachedCount).toBe(1);
    expect(summary1.passedCount).toBe(1);
    expect(summary1.fingerprint).toBe(summary2.fingerprint);
  });
});
