import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GoldenSnapshotService } from "./golden-snapshot.service";
import { FileGoldenSnapshotStore } from "./golden-snapshot-store";
import { GoldenSnapshotMetrics } from "./golden-snapshot-metrics";
import {
  processGoldenSnapshotVerification,
  transformAnalysisResultToGoldenOutput,
} from "./golden-snapshot-worker";
import { AnalysisResult, Severity } from "../../../../libs/engine/core/analyzer-interface";
import * as realisticFixture from "./__fixtures__/realistic-repo-fixture.json";
import * as regressionFixture from "./__fixtures__/regression-case-fixture.json";
import { LanguageGoldenOutput } from "./golden-snapshot-types";

describe("Golden Snapshot End-to-End & Integration", () => {
  let tmpDir: string;
  let store: FileGoldenSnapshotStore;
  let metrics: GoldenSnapshotMetrics;
  let service: GoldenSnapshotService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-snapshot-integ-"));
    store = new FileGoldenSnapshotStore(tmpDir);
    metrics = new GoldenSnapshotMetrics();
    service = new GoldenSnapshotService(
      store,
      {
        enabled: true,
        storageDir: tmpDir,
        enforceMatching: false,
        autoUpdate: false,
        maxDiffCount: 100,
        maxPayloadSizeBytes: 1024 * 1024,
      },
      metrics,
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("completes full pipeline: creation, disk persistence, worker adapter verification", async () => {
    // 1. Create golden snapshot on disk
    await service.createOrUpdateSnapshot({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    // 2. Mock raw AnalysisResult objects from engine for multiple languages
    const mockSolidityResult: AnalysisResult = {
      findings: [
        {
          ruleId: "gas-opt-uncached-array-length",
          message: "Array length should be cached outside for-loop condition to save gas",
          severity: Severity.LOW,
          location: {
            file: "contracts/evm/BridgeVault.sol",
            startLine: 45,
            endLine: 45,
            startColumn: 12,
            endColumn: 30,
          },
          estimatedGasSavings: 320,
        },
        {
          ruleId: "sec-reentrancy-eth-transfer",
          message: "Potential reentrancy vulnerability via external call before state update",
          severity: Severity.HIGH,
          location: {
            file: "contracts/evm/BridgeVault.sol",
            startLine: 112,
            endLine: 118,
            startColumn: 8,
            endColumn: 10,
          },
        },
      ],
      filesAnalyzed: 2,
      analysisTime: 120,
      analyzerVersion: "2.1.0",
      summary: {
        critical: 0,
        high: 1,
        medium: 0,
        low: 1,
        info: 0,
      },
      totalEstimatedGasSavings: 320,
    };

    const mockSorobanResult: AnalysisResult = {
      findings: [
        {
          ruleId: "soroban-storage-rent-bump",
          message: "Persistent storage entry missing rent bump on active access",
          severity: Severity.MEDIUM,
          location: {
            file: "contracts/soroban/amm_pool/src/lib.rs",
            startLine: 78,
            endLine: 82,
            startColumn: 4,
            endColumn: 6,
          },
        },
      ],
      filesAnalyzed: 4,
      analysisTime: 230,
      analyzerVersion: "2.1.0",
      summary: {
        critical: 0,
        high: 0,
        medium: 1,
        low: 0,
        info: 0,
      },
    };

    const mockRustResult: AnalysisResult = {
      findings: [],
      filesAnalyzed: 2,
      analysisTime: 85,
      analyzerVersion: "2.1.0",
      summary: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    };

    // 3. Worker processes verification against stored golden snapshot
    const verification = await processGoldenSnapshotVerification(service, {
      tenantId: realisticFixture.tenantId,
      scanId: "scan-worker-e2e-1",
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      analysisResults: {
        solidity: mockSolidityResult,
        soroban: mockSorobanResult,
        rust: mockRustResult,
      },
    });

    expect(verification.status).toBe("matched");
    expect(verification.matched).toBe(true);
    expect(verification.totalDifferences).toBe(0);

    // 4. Verify persistence of verification on disk
    const savedVerif = await store.getLatestVerification(
      realisticFixture.tenantId,
      realisticFixture.repositoryId,
    );
    expect(savedVerif).toBeDefined();
    expect(savedVerif?.matched).toBe(true);

    // 5. Verify metrics counters
    const counters = metrics.getCounters();
    expect(counters.snapshotsCreated).toBe(1);
    expect(counters.verificationsMatched).toBe(1);
  });

  it("detects regression with worker and writes failure to store", async () => {
    await service.createOrUpdateSnapshot({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    const regressedSolidityResult: AnalysisResult = {
      findings: [
        {
          ruleId: "sec-unexpected-regression-rule",
          message: "Spurious regression finding",
          severity: Severity.CRITICAL,
          location: {
            file: "contracts/evm/BridgeVault.sol",
            startLine: 1,
            endLine: 2,
          },
        },
      ],
      filesAnalyzed: 2,
      analysisTime: 120,
      analyzerVersion: "2.1.0",
      summary: {
        critical: 1,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    };

    const verification = await processGoldenSnapshotVerification(service, {
      tenantId: realisticFixture.tenantId,
      scanId: "scan-regressed-1",
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      analysisResults: {
        solidity: regressedSolidityResult,
      },
    });

    expect(verification.status).toBe("mismatched");
    expect(verification.matched).toBe(false);
    expect(verification.totalDifferences).toBeGreaterThan(0);

    const counters = metrics.getCounters();
    expect(counters.verificationsMismatched).toBe(1);
  });
});
