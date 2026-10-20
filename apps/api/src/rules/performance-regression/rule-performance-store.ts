/**
 * Persistence layer for rule performance regression baselines and evaluations (#1251).
 *
 * Provides tenant-isolated storage boundaries with both in-memory and file-based
 * implementations. Enforces optimistic concurrency / write-once semantics for scan pins,
 * and maintains per-tenant, per-repository baseline records.
 */

import * as fs from "fs";
import * as path from "path";
import {
  EvaluationSummary,
  RegressionTrackingScanPin,
  RulePerformanceBaseline,
  RulePerformanceRegressionError,
} from "./rule-performance-types";

export interface RulePerformanceStore {
  saveBaseline(baseline: RulePerformanceBaseline): Promise<void>;
  getBaseline(
    tenantId: string,
    repositoryId: string,
    ruleId: string,
    commitHash?: string,
  ): Promise<RulePerformanceBaseline | undefined>;
  getBaselinesForRepository(
    tenantId: string,
    repositoryId: string,
    commitHash?: string,
  ): Promise<Map<string, RulePerformanceBaseline>>;
  saveEvaluation(evaluation: EvaluationSummary): Promise<void>;
  getLatestEvaluation(
    tenantId: string,
    repositoryId: string,
  ): Promise<EvaluationSummary | undefined>;
  saveScanPin(pin: RegressionTrackingScanPin): Promise<RegressionTrackingScanPin>;
  getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<RegressionTrackingScanPin | undefined>;
}

export class InMemoryRulePerformanceStore implements RulePerformanceStore {
  // Key: `${tenantId}:${repositoryId}:${ruleId}:${commitHash}`
  private readonly baselines = new Map<string, RulePerformanceBaseline>();
  // Key: `${tenantId}:${repositoryId}:latest`
  private readonly latestBaselinesByRepo = new Map<string, Map<string, RulePerformanceBaseline>>();
  // Key: `${tenantId}:${repositoryId}`
  private readonly evaluations = new Map<string, EvaluationSummary>();
  // Key: `${tenantId}:${scanId}`
  private readonly pins = new Map<string, RegressionTrackingScanPin>();

  async saveBaseline(baseline: RulePerformanceBaseline): Promise<void> {
    const key = `${baseline.tenantId}:${baseline.repositoryId}:${baseline.ruleId}:${baseline.commitHash}`;
    this.baselines.set(key, { ...baseline });

    const repoKey = `${baseline.tenantId}:${baseline.repositoryId}`;
    if (!this.latestBaselinesByRepo.has(repoKey)) {
      this.latestBaselinesByRepo.set(repoKey, new Map());
    }
    this.latestBaselinesByRepo.get(repoKey)!.set(baseline.ruleId, { ...baseline });
  }

  async getBaseline(
    tenantId: string,
    repositoryId: string,
    ruleId: string,
    commitHash?: string,
  ): Promise<RulePerformanceBaseline | undefined> {
    if (commitHash) {
      const key = `${tenantId}:${repositoryId}:${ruleId}:${commitHash}`;
      return this.baselines.get(key);
    }
    const repoKey = `${tenantId}:${repositoryId}`;
    return this.latestBaselinesByRepo.get(repoKey)?.get(ruleId);
  }

  async getBaselinesForRepository(
    tenantId: string,
    repositoryId: string,
    commitHash?: string,
  ): Promise<Map<string, RulePerformanceBaseline>> {
    const result = new Map<string, RulePerformanceBaseline>();
    if (commitHash) {
      const prefix = `${tenantId}:${repositoryId}:`;
      const suffix = `:${commitHash}`;
      for (const [k, v] of this.baselines.entries()) {
        if (k.startsWith(prefix) && k.endsWith(suffix)) {
          result.set(v.ruleId, { ...v });
        }
      }
      return result;
    }

    const repoKey = `${tenantId}:${repositoryId}`;
    const latestMap = this.latestBaselinesByRepo.get(repoKey);
    if (latestMap) {
      for (const [ruleId, baseline] of latestMap.entries()) {
        result.set(ruleId, { ...baseline });
      }
    }
    return result;
  }

  async saveEvaluation(evaluation: EvaluationSummary): Promise<void> {
    const key = `${evaluation.tenantId}:${evaluation.repositoryId}`;
    this.evaluations.set(key, { ...evaluation });
  }

  async getLatestEvaluation(
    tenantId: string,
    repositoryId: string,
  ): Promise<EvaluationSummary | undefined> {
    const key = `${tenantId}:${repositoryId}`;
    return this.evaluations.get(key);
  }

  async saveScanPin(pin: RegressionTrackingScanPin): Promise<RegressionTrackingScanPin> {
    const key = `${pin.tenantId}:${pin.scanId}`;
    const existing = this.pins.get(key);
    if (existing) {
      return existing;
    }
    this.pins.set(key, { ...pin });
    return pin;
  }

  async getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<RegressionTrackingScanPin | undefined> {
    const key = `${tenantId}:${scanId}`;
    return this.pins.get(key);
  }
}

export class FileRulePerformanceStore implements RulePerformanceStore {
  constructor(private readonly baseDir: string) {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  private sanitizeFilename(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private getTenantDir(tenantId: string): string {
    const dir = path.join(this.baseDir, this.sanitizeFilename(tenantId));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async saveBaseline(baseline: RulePerformanceBaseline): Promise<void> {
    try {
      const tenantDir = this.getTenantDir(baseline.tenantId);
      const file = path.join(
        tenantDir,
        `baseline_${this.sanitizeFilename(baseline.repositoryId)}_${this.sanitizeFilename(baseline.ruleId)}_${baseline.commitHash}.json`,
      );
      await fs.promises.writeFile(file, JSON.stringify(baseline, null, 2), "utf8");

      // Also update latest pointer
      const latestFile = path.join(
        tenantDir,
        `baseline_latest_${this.sanitizeFilename(baseline.repositoryId)}_${this.sanitizeFilename(baseline.ruleId)}.json`,
      );
      await fs.promises.writeFile(latestFile, JSON.stringify(baseline, null, 2), "utf8");
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to write baseline to disk",
        err,
      );
    }
  }

  async getBaseline(
    tenantId: string,
    repositoryId: string,
    ruleId: string,
    commitHash?: string,
  ): Promise<RulePerformanceBaseline | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const file = commitHash
        ? path.join(
            tenantDir,
            `baseline_${this.sanitizeFilename(repositoryId)}_${this.sanitizeFilename(ruleId)}_${commitHash}.json`,
          )
        : path.join(
            tenantDir,
            `baseline_latest_${this.sanitizeFilename(repositoryId)}_${this.sanitizeFilename(ruleId)}.json`,
          );

      if (!fs.existsSync(file)) return undefined;
      const raw = await fs.promises.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to read baseline from disk",
        err,
      );
    }
  }

  async getBaselinesForRepository(
    tenantId: string,
    repositoryId: string,
    commitHash?: string,
  ): Promise<Map<string, RulePerformanceBaseline>> {
    try {
      const result = new Map<string, RulePerformanceBaseline>();
      const tenantDir = this.getTenantDir(tenantId);
      const files = await fs.promises.readdir(tenantDir);

      const targetPrefix = commitHash
        ? `baseline_${this.sanitizeFilename(repositoryId)}_`
        : `baseline_latest_${this.sanitizeFilename(repositoryId)}_`;

      for (const f of files) {
        if (f.startsWith(targetPrefix) && f.endsWith(".json")) {
          if (commitHash && !f.endsWith(`_${commitHash}.json`)) {
            continue;
          }
          const raw = await fs.promises.readFile(path.join(tenantDir, f), "utf8");
          const baseline: RulePerformanceBaseline = JSON.parse(raw);
          result.set(baseline.ruleId, baseline);
        }
      }
      return result;
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to read baselines for repository from disk",
        err,
      );
    }
  }

  async saveEvaluation(evaluation: EvaluationSummary): Promise<void> {
    try {
      const tenantDir = this.getTenantDir(evaluation.tenantId);
      const file = path.join(
        tenantDir,
        `eval_${this.sanitizeFilename(evaluation.repositoryId)}.json`,
      );
      await fs.promises.writeFile(file, JSON.stringify(evaluation, null, 2), "utf8");
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to save evaluation to disk",
        err,
      );
    }
  }

  async getLatestEvaluation(
    tenantId: string,
    repositoryId: string,
  ): Promise<EvaluationSummary | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const file = path.join(
        tenantDir,
        `eval_${this.sanitizeFilename(repositoryId)}.json`,
      );
      if (!fs.existsSync(file)) return undefined;
      const raw = await fs.promises.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to read latest evaluation from disk",
        err,
      );
    }
  }

  async saveScanPin(pin: RegressionTrackingScanPin): Promise<RegressionTrackingScanPin> {
    try {
      const tenantDir = this.getTenantDir(pin.tenantId);
      const file = path.join(tenantDir, `pin_${this.sanitizeFilename(pin.scanId)}.json`);
      if (fs.existsSync(file)) {
        const raw = await fs.promises.readFile(file, "utf8");
        return JSON.parse(raw);
      }
      await fs.promises.writeFile(file, JSON.stringify(pin, null, 2), "utf8");
      return pin;
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to save scan pin to disk",
        err,
      );
    }
  }

  async getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<RegressionTrackingScanPin | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const file = path.join(tenantDir, `pin_${this.sanitizeFilename(scanId)}.json`);
      if (!fs.existsSync(file)) return undefined;
      const raw = await fs.promises.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new RulePerformanceRegressionError(
        "STORE_UNAVAILABLE",
        "Failed to read scan pin from disk",
        err,
      );
    }
  }
}
