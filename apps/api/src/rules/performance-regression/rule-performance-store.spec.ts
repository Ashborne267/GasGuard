import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  FileRulePerformanceStore,
  InMemoryRulePerformanceStore,
  RulePerformanceStore,
} from "./rule-performance-store";
import {
  EvaluationSummary,
  RegressionTrackingScanPin,
  RulePerformanceBaseline,
} from "./rule-performance-types";

describe("RulePerformanceStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gasguard-perf-store-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const testStores: Array<{ name: string; create: () => RulePerformanceStore }> = [
    { name: "InMemoryRulePerformanceStore", create: () => new InMemoryRulePerformanceStore() },
    { name: "FileRulePerformanceStore", create: () => new FileRulePerformanceStore(tmpDir) },
  ];

  for (const { name, create } of testStores) {
    describe(name, () => {
      let store: RulePerformanceStore;

      beforeEach(() => {
        store = create();
      });

      const sampleBaseline: RulePerformanceBaseline = {
        tenantId: "tenant-a",
        repositoryId: "soroban-contracts",
        commitHash: "commit-101",
        rulePackVersion: "1.2.0",
        ruleId: "soroban-storage-rent",
        sampleCount: 5,
        meanDurationMs: 120,
        p95DurationMs: 150,
        meanMemoryBytes: 500000,
        p95MemoryBytes: 600000,
        errorRate: 0,
        createdAt: 1000,
        updatedAt: 1000,
      };

      it("saves and retrieves baselines by commit and latest", async () => {
        await store.saveBaseline(sampleBaseline);

        const byCommit = await store.getBaseline(
          "tenant-a",
          "soroban-contracts",
          "soroban-storage-rent",
          "commit-101",
        );
        expect(byCommit).toBeDefined();
        expect(byCommit?.meanDurationMs).toBe(120);

        const latest = await store.getBaseline(
          "tenant-a",
          "soroban-contracts",
          "soroban-storage-rent",
        );
        expect(latest).toBeDefined();
        expect(latest?.ruleId).toBe("soroban-storage-rent");
      });

      it("enforces tenant isolation", async () => {
        await store.saveBaseline(sampleBaseline);

        const otherTenant = await store.getBaseline(
          "tenant-b",
          "soroban-contracts",
          "soroban-storage-rent",
        );
        expect(otherTenant).toBeUndefined();
      });

      it("lists all baselines for a repository", async () => {
        await store.saveBaseline(sampleBaseline);
        await store.saveBaseline({
          ...sampleBaseline,
          ruleId: "soroban-cpu-cost",
          meanDurationMs: 80,
        });

        const all = await store.getBaselinesForRepository("tenant-a", "soroban-contracts");
        expect(all.size).toBe(2);
        expect(all.get("soroban-storage-rent")?.meanDurationMs).toBe(120);
        expect(all.get("soroban-cpu-cost")?.meanDurationMs).toBe(80);
      });

      it("persists scan pins with write-once semantics", async () => {
        const pin: RegressionTrackingScanPin = {
          tenantId: "tenant-a",
          scanId: "scan-999",
          repositoryId: "soroban-contracts",
          commitHash: "commit-101",
          rulePackVersion: "1.2.0",
          pinnedAt: 2000,
          fingerprint: "fp1234",
        };

        const firstSave = await store.saveScanPin(pin);
        expect(firstSave.scanId).toBe("scan-999");

        // Attempting to overwrite with different fingerprint returns original pin
        const secondSave = await store.saveScanPin({
          ...pin,
          fingerprint: "fp-modified",
        });
        expect(secondSave.fingerprint).toBe("fp1234");

        const retrieved = await store.getScanPin("tenant-a", "scan-999");
        expect(retrieved?.fingerprint).toBe("fp1234");
      });

      it("saves and retrieves evaluation summaries", async () => {
        const evalSummary: EvaluationSummary = {
          tenantId: "tenant-a",
          repositoryId: "soroban-contracts",
          commitHash: "commit-101",
          rulePackVersion: "1.2.0",
          status: "breached",
          totalRulesEvaluated: 1,
          passedCount: 0,
          warningCount: 0,
          breachedCount: 1,
          skippedRulesCount: 0,
          ruleEvaluations: [],
          evaluatedAt: 3000,
          fingerprint: "eval-fp",
        };

        await store.saveEvaluation(evalSummary);
        const retrieved = await store.getLatestEvaluation("tenant-a", "soroban-contracts");
        expect(retrieved).toBeDefined();
        expect(retrieved?.status).toBe("breached");
      });
    });
  }
});
