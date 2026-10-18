import { RulePerformanceService } from "./rule-performance.service";
import { InMemoryRulePerformanceStore } from "./rule-performance-store";
import { RuleExecutionSample } from "./rule-performance-types";

describe("RulePerformanceService", () => {
  let service: RulePerformanceService;
  let store: InMemoryRulePerformanceStore;

  beforeEach(() => {
    store = new InMemoryRulePerformanceStore();
    service = new RulePerformanceService({
      store,
      config: {
        defaultThresholds: {
          maxDurationMs: 1000,
          maxDurationDeltaPercent: 50,
          maxMemoryBytes: 2000000,
          maxMemoryDeltaPercent: 50,
        },
      },
      clock: () => 100000,
    });
  });

  it("pins scan attempts and reuses the pin across retries", async () => {
    const pinRes1 = await service.pinScan({
      tenantId: "tenant-alpha",
      scanId: "scan-123",
      repositoryId: "repo-xyz",
      commitHash: "c1",
      rulePackVersion: "1.0.0",
    });
    expect(pinRes1.status).toBe("created");
    expect(pinRes1.pin.scanId).toBe("scan-123");

    const pinRes2 = await service.pinScan({
      tenantId: "tenant-alpha",
      scanId: "scan-123",
      repositoryId: "repo-xyz",
      commitHash: "c1",
      rulePackVersion: "1.0.0",
    });
    expect(pinRes2.status).toBe("reused");
    expect(pinRes2.pin.fingerprint).toBe(pinRes1.pin.fingerprint);
  });

  it("establishes baselines and detects performance regressions in scans", async () => {
    // 1. Establish baseline
    const baselineSamples: RuleExecutionSample[] = [
      {
        ruleId: "soroban-storage-rent",
        durationMs: 200,
        memoryBytes: 500000,
        status: "ok",
        findingsCount: 1,
      },
    ];

    const established = await service.establishBaselines({
      tenantId: "tenant-alpha",
      repositoryId: "repo-xyz",
      commitHash: "c1",
      rulePackVersion: "1.0.0",
      samples: baselineSamples,
    });
    expect(established).toBe(1);

    // 2. Run scan with normal metrics -> passes
    const normalSamples: RuleExecutionSample[] = [
      {
        ruleId: "soroban-storage-rent",
        durationMs: 210,
        memoryBytes: 510000,
        status: "ok",
        findingsCount: 1,
      },
    ];

    const eval1 = await service.evaluateScanPerformance({
      tenantId: "tenant-alpha",
      scanId: "scan-101",
      repositoryId: "repo-xyz",
      commitHash: "c2",
      rulePackVersion: "1.0.0",
      samples: normalSamples,
    });
    expect(eval1.status).toBe("passed");
    expect(eval1.breachedCount).toBe(0);

    // 3. Run scan with regressed duration (+150%) -> breaches
    const regressedSamples: RuleExecutionSample[] = [
      {
        ruleId: "soroban-storage-rent",
        durationMs: 500, // 500 vs 200 is +150% regression
        memoryBytes: 520000,
        status: "ok",
        findingsCount: 1,
      },
    ];

    const eval2 = await service.evaluateScanPerformance({
      tenantId: "tenant-alpha",
      scanId: "scan-102",
      repositoryId: "repo-xyz",
      commitHash: "c3",
      rulePackVersion: "1.0.0",
      samples: regressedSamples,
    });
    expect(eval2.status).toBe("breached");
    expect(eval2.breachedCount).toBe(1);
    expect(eval2.ruleEvaluations[0].breaches[0].deltaPercent).toBe(150);
  });

  it("handles kill-switch being disabled gracefully", async () => {
    const disabledService = new RulePerformanceService({
      store,
      config: { enabled: false },
    });

    const evalRes = await disabledService.evaluateScanPerformance({
      tenantId: "tenant-alpha",
      scanId: "scan-disabled",
      repositoryId: "repo-xyz",
      commitHash: "c4",
      rulePackVersion: "1.0.0",
      samples: [
        { ruleId: "soroban-storage-rent", durationMs: 99999, status: "ok", findingsCount: 0 },
      ],
    });

    expect(evalRes.status).toBe("passed");
    expect(evalRes.totalRulesEvaluated).toBe(0);
  });

  it("validates tenant and repository identifiers", async () => {
    await expect(
      service.evaluateScanPerformance({
        tenantId: "",
        scanId: "scan-1",
        repositoryId: "repo-1",
        commitHash: "c1",
        rulePackVersion: "1.0.0",
        samples: [],
      }),
    ).rejects.toThrow("[INVALID_INPUT]");
  });
});
