/**
 * Service boundary for Golden Output Snapshots (#1253).
 *
 * Coordinates snapshot creation, verification against analysis runs,
 * tenant isolation, scan pinning, metrics, and persistence.
 */

import {
  GoldenSnapshotConfig,
  loadGoldenSnapshotConfig,
} from "./golden-snapshot-config";
import {
  GoldenSnapshotManifest,
  LanguageGoldenOutput,
  SnapshotVerificationResult,
  GoldenSnapshotScanPin,
  GoldenSnapshotError,
} from "./golden-snapshot-types";
import {
  GoldenSnapshotStore,
  InMemoryGoldenSnapshotStore,
} from "./golden-snapshot-store";
import {
  createSnapshotManifest,
  verifySnapshotAgainstOutputs,
} from "./golden-snapshot-evaluator";
import {
  GoldenSnapshotMetrics,
  sanitizeLogContext,
} from "./golden-snapshot-metrics";

export interface CreateSnapshotRequest {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  languageOutputs: Record<string, LanguageGoldenOutput>;
  metadata?: Record<string, unknown>;
}

export interface VerifySnapshotRequest {
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  actualOutputs: Record<string, LanguageGoldenOutput>;
}

export class GoldenSnapshotService {
  constructor(
    private readonly store: GoldenSnapshotStore = new InMemoryGoldenSnapshotStore(),
    private readonly config: GoldenSnapshotConfig = loadGoldenSnapshotConfig(),
    private readonly metrics: GoldenSnapshotMetrics = new GoldenSnapshotMetrics(),
    private readonly logger: {
      log: (msg: string, ctx?: Record<string, unknown>) => void;
      warn: (msg: string, ctx?: Record<string, unknown>) => void;
      error: (msg: string, ctx?: Record<string, unknown>) => void;
    } = {
      log: (msg, ctx) => console.log(`[GoldenSnapshotService] ${msg}`, ctx ? sanitizeLogContext(ctx) : ""),
      warn: (msg, ctx) => console.warn(`[GoldenSnapshotService] ${msg}`, ctx ? sanitizeLogContext(ctx) : ""),
      error: (msg, ctx) => console.error(`[GoldenSnapshotService] ${msg}`, ctx ? sanitizeLogContext(ctx) : ""),
    },
  ) {}

  getConfig(): GoldenSnapshotConfig {
    return this.config;
  }

  getMetrics(): GoldenSnapshotMetrics {
    return this.metrics;
  }

  async createOrUpdateSnapshot(
    request: CreateSnapshotRequest,
  ): Promise<GoldenSnapshotManifest> {
    if (!this.config.enabled) {
      throw new GoldenSnapshotError(
        "SNAPSHOT_DISABLED",
        "Golden snapshot service is disabled by configuration",
      );
    }

    const manifest = createSnapshotManifest({
      tenantId: request.tenantId,
      repositoryId: request.repositoryId,
      commitHash: request.commitHash,
      rulePackVersion: request.rulePackVersion,
      languageOutputs: request.languageOutputs,
      metadata: request.metadata,
    });

    await this.store.saveSnapshot(manifest);
    this.metrics.recordSnapshotCreated(manifest.supportedLanguages.length);

    this.logger.log("Created golden snapshot manifest", {
      tenantId: manifest.tenantId,
      repositoryId: manifest.repositoryId,
      commitHash: manifest.commitHash,
      rulePackVersion: manifest.rulePackVersion,
      fingerprint: manifest.fingerprint,
      languageCount: manifest.supportedLanguages.length,
    });

    return manifest;
  }

  async getSnapshot(
    tenantId: string,
    repositoryId: string,
    commitHash: string,
    rulePackVersion?: string,
  ): Promise<GoldenSnapshotManifest | undefined> {
    return this.store.getSnapshot(tenantId, repositoryId, commitHash, rulePackVersion);
  }

  async verifyOutputs(
    request: VerifySnapshotRequest,
  ): Promise<SnapshotVerificationResult> {
    if (!this.config.enabled) {
      return {
        status: "matched",
        matched: true,
        tenantId: request.tenantId,
        repositoryId: request.repositoryId,
        commitHash: request.commitHash,
        rulePackVersion: request.rulePackVersion,
        expectedFingerprint: "disabled",
        actualFingerprint: "disabled",
        languageResults: {},
        totalDifferences: 0,
        verifiedAt: Date.now(),
      };
    }

    if (!request.scanId || typeof request.scanId !== "string") {
      throw new GoldenSnapshotError("INVALID_INPUT", "scanId must be a valid non-empty string");
    }

    // Resolve or establish scan pin for determinism across retries
    let pin = await this.store.getScanPin(request.tenantId, request.scanId);
    let goldenManifest: GoldenSnapshotManifest | undefined;

    if (pin) {
      goldenManifest = await this.store.getSnapshotById(request.tenantId, pin.snapshotId);
      if (!goldenManifest) {
        goldenManifest = await this.store.getSnapshot(
          request.tenantId,
          request.repositoryId,
          pin.commitHash,
          pin.rulePackVersion,
        );
      }
    } else {
      goldenManifest = await this.store.getSnapshot(
        request.tenantId,
        request.repositoryId,
        request.commitHash,
        request.rulePackVersion,
      );

      if (goldenManifest) {
        pin = {
          tenantId: request.tenantId,
          scanId: request.scanId,
          repositoryId: request.repositoryId,
          commitHash: request.commitHash,
          rulePackVersion: request.rulePackVersion,
          snapshotId: goldenManifest.snapshotId,
          pinnedAt: Date.now(),
          fingerprint: goldenManifest.fingerprint,
        };
        await this.store.saveScanPin(pin);
      }
    }

    if (!goldenManifest) {
      if (this.config.autoUpdate) {
        this.logger.warn("Golden snapshot not found, autoUpdate is enabled. Generating snapshot.", {
          tenantId: request.tenantId,
          repositoryId: request.repositoryId,
          commitHash: request.commitHash,
        });
        const created = await this.createOrUpdateSnapshot({
          tenantId: request.tenantId,
          repositoryId: request.repositoryId,
          commitHash: request.commitHash,
          rulePackVersion: request.rulePackVersion,
          languageOutputs: request.actualOutputs,
        });
        return this.verifyOutputs(request);
      }

      const missingResult: SnapshotVerificationResult = {
        status: "missing",
        matched: false,
        tenantId: request.tenantId,
        repositoryId: request.repositoryId,
        commitHash: request.commitHash,
        rulePackVersion: request.rulePackVersion,
        expectedFingerprint: "",
        actualFingerprint: "",
        languageResults: {},
        totalDifferences: 1,
        verifiedAt: Date.now(),
      };

      this.metrics.recordVerification("missing", {});
      await this.store.saveVerification(missingResult);

      if (this.config.enforceMatching) {
        throw new GoldenSnapshotError(
          "SNAPSHOT_NOT_FOUND",
          `No golden snapshot found for repository '${request.repositoryId}' at commit '${request.commitHash}'`,
        );
      }

      return missingResult;
    }

    const verification = verifySnapshotAgainstOutputs({
      goldenManifest,
      actualOutputs: request.actualOutputs,
      maxDiffs: this.config.maxDiffCount,
    });

    await this.store.saveVerification(verification);
    this.metrics.recordVerification(verification.status, verification.languageResults);

    this.logger.log("Verified analysis outputs against golden snapshot", {
      tenantId: verification.tenantId,
      repositoryId: verification.repositoryId,
      status: verification.status,
      matched: verification.matched,
      differences: verification.totalDifferences,
    });

    if (!verification.matched && this.config.enforceMatching) {
      throw new GoldenSnapshotError(
        "INVALID_INPUT",
        `Golden output snapshot verification failed with ${verification.totalDifferences} differences`,
        verification,
      );
    }

    return verification;
  }
}
