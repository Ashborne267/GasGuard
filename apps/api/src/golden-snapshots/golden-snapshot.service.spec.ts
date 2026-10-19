import { GoldenSnapshotService } from "./golden-snapshot.service";
import { InMemoryGoldenSnapshotStore } from "./golden-snapshot-store";
import { GoldenSnapshotMetrics } from "./golden-snapshot-metrics";
import { GoldenSnapshotError, LanguageGoldenOutput } from "./golden-snapshot-types";
import * as realisticFixture from "./__fixtures__/realistic-repo-fixture.json";
import * as regressionFixture from "./__fixtures__/regression-case-fixture.json";

describe("GoldenSnapshotService", () => {
  let service: GoldenSnapshotService;
  let store: InMemoryGoldenSnapshotStore;
  let metrics: GoldenSnapshotMetrics;

  beforeEach(() => {
    store = new InMemoryGoldenSnapshotStore();
    metrics = new GoldenSnapshotMetrics();
    service = new GoldenSnapshotService(
      store,
      {
        enabled: true,
        storageDir: "./data",
        enforceMatching: false,
        autoUpdate: false,
        maxDiffCount: 50,
        maxPayloadSizeBytes: 1024 * 1024,
      },
      metrics,
    );
  });

  it("creates, retrieves, and verifies golden snapshots", async () => {
    const manifest = await service.createOrUpdateSnapshot({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    expect(manifest.supportedLanguages).toContain("solidity");

    const verification = await service.verifyOutputs({
      tenantId: realisticFixture.tenantId,
      scanId: "scan-1",
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      actualOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    expect(verification.status).toBe("matched");
    expect(verification.matched).toBe(true);
    expect(verification.totalDifferences).toBe(0);
  });

  it("handles missing snapshots gracefully when enforceMatching is false", async () => {
    const verification = await service.verifyOutputs({
      tenantId: "nonexistent",
      scanId: "scan-2",
      repositoryId: "repo-unknown",
      commitHash: "hash-unknown",
      rulePackVersion: "1.0.0",
      actualOutputs: {},
    });

    expect(verification.status).toBe("missing");
    expect(verification.matched).toBe(false);
  });

  it("throws SNAPSHOT_NOT_FOUND when enforceMatching is true and snapshot is missing", async () => {
    const strictService = new GoldenSnapshotService(
      store,
      {
        enabled: true,
        storageDir: "./data",
        enforceMatching: true,
        autoUpdate: false,
        maxDiffCount: 50,
        maxPayloadSizeBytes: 1024 * 1024,
      },
      metrics,
    );

    await expect(
      strictService.verifyOutputs({
        tenantId: "nonexistent",
        scanId: "scan-3",
        repositoryId: "repo-strict",
        commitHash: "hash-strict",
        rulePackVersion: "1.0.0",
        actualOutputs: {},
      }),
    ).rejects.toThrow(GoldenSnapshotError);
  });

  it("pins scan attempts idempotently across retries", async () => {
    await service.createOrUpdateSnapshot({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    // First attempt establishes pin
    const res1 = await service.verifyOutputs({
      tenantId: realisticFixture.tenantId,
      scanId: "scan-retryable",
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      actualOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });
    expect(res1.status).toBe("matched");

    const pin = await store.getScanPin(realisticFixture.tenantId, "scan-retryable");
    expect(pin).toBeDefined();

    // Second attempt reuses pin
    const res2 = await service.verifyOutputs({
      tenantId: realisticFixture.tenantId,
      scanId: "scan-retryable",
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      actualOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });
    expect(res2.status).toBe("matched");
  });

  it("handles autoUpdate when snapshot is missing", async () => {
    const autoService = new GoldenSnapshotService(
      store,
      {
        enabled: true,
        storageDir: "./data",
        enforceMatching: false,
        autoUpdate: true,
        maxDiffCount: 50,
        maxPayloadSizeBytes: 1024 * 1024,
      },
      metrics,
    );

    const res = await autoService.verifyOutputs({
      tenantId: "new-tenant",
      scanId: "scan-auto",
      repositoryId: "new-repo",
      commitHash: "new-commit",
      rulePackVersion: "1.0.0",
      actualOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    expect(res.status).toBe("matched");
    const created = await store.getSnapshot("new-tenant", "new-repo", "new-commit", "1.0.0");
    expect(created).toBeDefined();
  });
});
