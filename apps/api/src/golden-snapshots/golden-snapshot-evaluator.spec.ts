import {
  canonicalizeFindings,
  computeSnapshotFingerprint,
  createSnapshotManifest,
  verifySnapshotAgainstOutputs,
} from "./golden-snapshot-evaluator";
import { GoldenFindingSnapshot, LanguageGoldenOutput, GoldenSnapshotError } from "./golden-snapshot-types";
import * as realisticFixture from "./__fixtures__/realistic-repo-fixture.json";
import * as regressionFixture from "./__fixtures__/regression-case-fixture.json";

describe("GoldenSnapshotEvaluator", () => {
  it("canonicalizes findings deterministically regardless of input ordering", () => {
    const f1: GoldenFindingSnapshot = {
      ruleId: "rule-b",
      message: "Message B",
      severity: "low",
      location: { file: "src/b.ts", startLine: 10, endLine: 12 },
    };
    const f2: GoldenFindingSnapshot = {
      ruleId: "rule-a",
      message: "Message A",
      severity: "high",
      location: { file: "src/a.ts", startLine: 5, endLine: 6 },
    };
    const f3: GoldenFindingSnapshot = {
      ruleId: "rule-c",
      message: "Message C",
      severity: "medium",
      location: { file: "src/b.ts", startLine: 2, endLine: 3 },
    };

    const ordered = canonicalizeFindings([f1, f2, f3]);
    expect(ordered.map((f) => f.ruleId)).toEqual(["rule-a", "rule-c", "rule-b"]);

    const ordered2 = canonicalizeFindings([f3, f1, f2]);
    expect(ordered2.map((f) => f.ruleId)).toEqual(["rule-a", "rule-c", "rule-b"]);
  });

  it("produces identical fingerprints for identical inputs", () => {
    const langOutputs = realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>;
    const fp1 = computeSnapshotFingerprint("tenant-1", "repo-1", "commit-1", "1.0.0", langOutputs);
    const fp2 = computeSnapshotFingerprint("tenant-1", "repo-1", "commit-1", "1.0.0", langOutputs);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
  });

  it("produces different fingerprints when inputs change", () => {
    const langOutputs = realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>;
    const fp1 = computeSnapshotFingerprint("tenant-1", "repo-1", "commit-1", "1.0.0", langOutputs);
    const fp2 = computeSnapshotFingerprint("tenant-2", "repo-1", "commit-1", "1.0.0", langOutputs);
    const fp3 = computeSnapshotFingerprint("tenant-1", "repo-1", "commit-2", "1.0.0", langOutputs);
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  it("creates valid snapshot manifest from realistic fixture", () => {
    const manifest = createSnapshotManifest({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
      clock: () => 1700000000000,
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.supportedLanguages).toEqual(["rust", "solidity", "soroban"]);
    expect(manifest.createdAt).toBe(1700000000000);
    expect(manifest.snapshotId).toContain(realisticFixture.commitHash.slice(0, 12));
  });

  it("validates input fields and rejects invalid inputs", () => {
    expect(() =>
      createSnapshotManifest({
        tenantId: "",
        repositoryId: "repo",
        commitHash: "hash",
        rulePackVersion: "1.0.0",
        languageOutputs: {},
      }),
    ).toThrow(GoldenSnapshotError);

    expect(() =>
      createSnapshotManifest({
        tenantId: "tenant",
        repositoryId: "",
        commitHash: "hash",
        rulePackVersion: "1.0.0",
        languageOutputs: {},
      }),
    ).toThrow(GoldenSnapshotError);
  });

  it("verifies identical outputs as matched", () => {
    const manifest = createSnapshotManifest({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    const result = verifySnapshotAgainstOutputs({
      goldenManifest: manifest,
      actualOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    expect(result.status).toBe("matched");
    expect(result.matched).toBe(true);
    expect(result.totalDifferences).toBe(0);
    expect(result.expectedFingerprint).toBe(result.actualFingerprint);
  });

  it("detects regressions and diffs from regression fixture", () => {
    const manifest = createSnapshotManifest({
      tenantId: realisticFixture.tenantId,
      repositoryId: realisticFixture.repositoryId,
      commitHash: realisticFixture.commitHash,
      rulePackVersion: realisticFixture.rulePackVersion,
      languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
    });

    const result = verifySnapshotAgainstOutputs({
      goldenManifest: manifest,
      actualOutputs: regressionFixture.actualOutputsWithRegression as Record<string, LanguageGoldenOutput>,
    });

    expect(result.status).toBe("mismatched");
    expect(result.matched).toBe(false);
    expect(result.totalDifferences).toBeGreaterThan(0);
    expect(result.languageResults["solidity"].matched).toBe(false);
    expect(result.languageResults["rust"].matched).toBe(false); // rust missing in regression
  });
});
