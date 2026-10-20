import { RulePerformanceService } from "./rule-performance.service";
import { InMemoryRulePerformanceStore } from "./rule-performance-store";
import {
  runRulesWithPerformanceTracking,
  ScanWorkerRuleExecution,
} from "./rule-performance-worker";
import realisticFixture from "./__fixtures__/realistic-repo-fixture.json";
import regressionFixture from "./__fixtures__/regression-case-fixture.json";

describe("RulePerformanceIntegration", () => {
  let service: RulePerformanceService;
  let store: InMemoryRulePerformanceStore;

  beforeEach(() => {
    store = new InMemoryRulePerformanceStore();
    service = new RulePerformanceService({
      store,
      config: {
        defaultThresholds: {
          maxDurationMs: 2000,
          maxDurationDeltaPercent: 50,
          maxMemoryBytes: 50 * 1024 * 1024,
          maxMemoryDeltaPercent: 50,
        },
      },
    });
  });

  it("handles realistic repository scan flow and establishes baseline", async () => {
    // 1. Establish baseline from realistic fixture
    const count = await service.establishBaselines({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.baselineCommit,
      rulePackVersion: realisticFixture.rulePackVersion,
      samples: realisticFixture.baselineSamples as any,
    });
    expect(count).toBe(3);

    // 2. Worker executes scan with realistic rules
    const rules: ScanWorkerRuleExecution[] = realisticFixture.normalScanSamples.map(
      (s) => ({
        ruleId: s.ruleId,
        execute: async () => [{ finding: `finding-for-${s.ruleId}` }],
      }),
    );

    const { results, evaluation } = await runRulesWithPerformanceTracking(
      rules,
      {
        service,
        tenantId: realisticFixture.tenantId,
        scanId: "scan-normal-001",
        repositoryId: realisticFixture.repositoryId,
        commitHash: realisticFixture.currentCommit,
        rulePackVersion: realisticFixture.rulePackVersion,
      },
    );

    expect(results.size).toBe(3);
    expect(evaluation.status).toBe("passed");
    expect(evaluation.breachedCount).toBe(0);
  });

  it("evaluates regression case fixture and flags breached rules", async () => {
    // Establish baseline
    await service.establishBaselines({
      tenantId: regressionFixture.tenantId,
      repositoryId: regressionFixture.repositoryId,
      commitHash: regressionFixture.baselineCommit,
      rulePackVersion: regressionFixture.rulePackVersion,
      samples: realisticFixture.baselineSamples as any,
    });

    // Evaluate regressed samples
    const evalSummary = await service.evaluateScanPerformance({
      tenantId: regressionFixture.tenantId,
      scanId: "scan-regressed-001",
      repositoryId: regressionFixture.repositoryId,
      commitHash: regressionFixture.regressedCommit,
      rulePackVersion: regressionFixture.rulePackVersion,
      samples: regressionFixture.regressedSamples as any,
    });

    expect(evalSummary.status).toBe("breached");
    expect(evalSummary.breachedCount).toBeGreaterThanOrEqual(1);

    const breachedRuleIds = evalSummary.ruleEvaluations
      .filter((e) => e.status === "breached")
      .map((e) => e.ruleId);

    expect(breachedRuleIds).toEqual(
      expect.arrayContaining(regressionFixture.expectedBreachedRules),
    );
  });

  it("handles worker partial failure gracefully without dropping other rule outcomes", async () => {
    const rules: ScanWorkerRuleExecution[] = [
      {
        ruleId: "soroban-constant-propagation",
        execute: () => [{ id: "const-1" }],
      },
      {
        ruleId: "broken-rule",
        execute: () => {
          throw new Error("Syntax error in AST parsing");
        },
      },
    ];

    const { results, evaluation } = await runRulesWithPerformanceTracking(
      rules,
      {
        service,
        tenantId: "tenant-fault-tolerance",
        scanId: "scan-partial-001",
        repositoryId: "repo-demo",
        commitHash: "c-fault",
        rulePackVersion: "1.0.0",
      },
    );

    expect(results.get("soroban-constant-propagation")).toEqual([{ id: "const-1" }]);
    expect(results.get("broken-rule")).toEqual([]);
    expect(evaluation.totalRulesEvaluated).toBe(2);

    const brokenEval = evaluation.ruleEvaluations.find((e) => e.ruleId === "broken-rule");
    expect(brokenEval).toBeDefined();
    expect(brokenEval?.errorRate).toBe(1.0);
  });
});
