/**
 * Persistence layer for Golden Output Snapshots (#1253).
 *
 * Implements strict tenant isolation, memory store, and sanitized file-system persistence.
 */

import * as fs from "fs";
import * as path from "path";
import {
  GoldenSnapshotManifest,
  SnapshotVerificationResult,
  GoldenSnapshotScanPin,
  GoldenSnapshotError,
} from "./golden-snapshot-types";

export interface GoldenSnapshotStore {
  saveSnapshot(manifest: GoldenSnapshotManifest): Promise<void>;
  getSnapshot(
    tenantId: string,
    repositoryId: string,
    commitHash: string,
    rulePackVersion?: string,
  ): Promise<GoldenSnapshotManifest | undefined>;
  getSnapshotById(
    tenantId: string,
    snapshotId: string,
  ): Promise<GoldenSnapshotManifest | undefined>;
  saveVerification(verification: SnapshotVerificationResult): Promise<void>;
  getLatestVerification(
    tenantId: string,
    repositoryId: string,
  ): Promise<SnapshotVerificationResult | undefined>;
  saveScanPin(pin: GoldenSnapshotScanPin): Promise<GoldenSnapshotScanPin>;
  getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<GoldenSnapshotScanPin | undefined>;
}

export class InMemoryGoldenSnapshotStore implements GoldenSnapshotStore {
  private snapshots: Map<string, GoldenSnapshotManifest> = new Map();
  private verifications: Map<string, SnapshotVerificationResult> = new Map();
  private pins: Map<string, GoldenSnapshotScanPin> = new Map();

  private makeKey(
    tenantId: string,
    repositoryId: string,
    commitHash: string,
    rulePackVersion?: string,
  ): string {
    return rulePackVersion
      ? `${tenantId}::${repositoryId}::${commitHash}::${rulePackVersion}`
      : `${tenantId}::${repositoryId}::${commitHash}`;
  }

  async saveSnapshot(manifest: GoldenSnapshotManifest): Promise<void> {
    const key = this.makeKey(
      manifest.tenantId,
      manifest.repositoryId,
      manifest.commitHash,
      manifest.rulePackVersion,
    );
    this.snapshots.set(key, JSON.parse(JSON.stringify(manifest)));
    this.snapshots.set(
      `${manifest.tenantId}::id::${manifest.snapshotId}`,
      JSON.parse(JSON.stringify(manifest)),
    );
  }

  async getSnapshot(
    tenantId: string,
    repositoryId: string,
    commitHash: string,
    rulePackVersion?: string,
  ): Promise<GoldenSnapshotManifest | undefined> {
    if (rulePackVersion) {
      const key = this.makeKey(tenantId, repositoryId, commitHash, rulePackVersion);
      return this.snapshots.get(key);
    }
    const prefix = `${tenantId}::${repositoryId}::${commitHash}`;
    for (const [k, v] of this.snapshots.entries()) {
      if (k.startsWith(prefix)) {
        return v;
      }
    }
    return undefined;
  }

  async getSnapshotById(
    tenantId: string,
    snapshotId: string,
  ): Promise<GoldenSnapshotManifest | undefined> {
    return this.snapshots.get(`${tenantId}::id::${snapshotId}`);
  }

  async saveVerification(verification: SnapshotVerificationResult): Promise<void> {
    const key = `${verification.tenantId}::${verification.repositoryId}`;
    this.verifications.set(key, JSON.parse(JSON.stringify(verification)));
  }

  async getLatestVerification(
    tenantId: string,
    repositoryId: string,
  ): Promise<SnapshotVerificationResult | undefined> {
    const key = `${tenantId}::${repositoryId}`;
    return this.verifications.get(key);
  }

  async saveScanPin(pin: GoldenSnapshotScanPin): Promise<GoldenSnapshotScanPin> {
    const key = `${pin.tenantId}::${pin.scanId}`;
    const existing = this.pins.get(key);
    if (existing) {
      return existing;
    }
    this.pins.set(key, JSON.parse(JSON.stringify(pin)));
    return pin;
  }

  async getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<GoldenSnapshotScanPin | undefined> {
    return this.pins.get(`${tenantId}::${scanId}`);
  }
}

export class FileGoldenSnapshotStore implements GoldenSnapshotStore {
  constructor(private readonly baseDir: string) {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  private sanitize(str: string): string {
    return str.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private getTenantDir(tenantId: string): string {
    const dir = path.join(this.baseDir, this.sanitize(tenantId));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async saveSnapshot(manifest: GoldenSnapshotManifest): Promise<void> {
    try {
      const tenantDir = this.getTenantDir(manifest.tenantId);
      const filename = `snapshot_${this.sanitize(manifest.repositoryId)}_${this.sanitize(manifest.commitHash)}_${this.sanitize(manifest.rulePackVersion)}.json`;
      const fullPath = path.join(tenantDir, filename);
      await fs.promises.writeFile(fullPath, JSON.stringify(manifest, null, 2), "utf8");

      // Pointer by ID
      const idPath = path.join(tenantDir, `id_${this.sanitize(manifest.snapshotId)}.json`);
      await fs.promises.writeFile(idPath, JSON.stringify(manifest, null, 2), "utf8");
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to write snapshot to disk",
        err,
      );
    }
  }

  async getSnapshot(
    tenantId: string,
    repositoryId: string,
    commitHash: string,
    rulePackVersion?: string,
  ): Promise<GoldenSnapshotManifest | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      if (rulePackVersion) {
        const filename = `snapshot_${this.sanitize(repositoryId)}_${this.sanitize(commitHash)}_${this.sanitize(rulePackVersion)}.json`;
        const fullPath = path.join(tenantDir, filename);
        if (!fs.existsSync(fullPath)) return undefined;
        const raw = await fs.promises.readFile(fullPath, "utf8");
        return JSON.parse(raw);
      }

      const prefix = `snapshot_${this.sanitize(repositoryId)}_${this.sanitize(commitHash)}_`;
      const files = await fs.promises.readdir(tenantDir);
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith(".json")) {
          const raw = await fs.promises.readFile(path.join(tenantDir, f), "utf8");
          return JSON.parse(raw);
        }
      }
      return undefined;
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to read snapshot from disk",
        err,
      );
    }
  }

  async getSnapshotById(
    tenantId: string,
    snapshotId: string,
  ): Promise<GoldenSnapshotManifest | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const idPath = path.join(tenantDir, `id_${this.sanitize(snapshotId)}.json`);
      if (!fs.existsSync(idPath)) return undefined;
      const raw = await fs.promises.readFile(idPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to read snapshot by ID from disk",
        err,
      );
    }
  }

  async saveVerification(verification: SnapshotVerificationResult): Promise<void> {
    try {
      const tenantDir = this.getTenantDir(verification.tenantId);
      const fullPath = path.join(
        tenantDir,
        `verif_${this.sanitize(verification.repositoryId)}.json`,
      );
      await fs.promises.writeFile(fullPath, JSON.stringify(verification, null, 2), "utf8");
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to save verification to disk",
        err,
      );
    }
  }

  async getLatestVerification(
    tenantId: string,
    repositoryId: string,
  ): Promise<SnapshotVerificationResult | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const fullPath = path.join(
        tenantDir,
        `verif_${this.sanitize(repositoryId)}.json`,
      );
      if (!fs.existsSync(fullPath)) return undefined;
      const raw = await fs.promises.readFile(fullPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to read verification from disk",
        err,
      );
    }
  }

  async saveScanPin(pin: GoldenSnapshotScanPin): Promise<GoldenSnapshotScanPin> {
    try {
      const tenantDir = this.getTenantDir(pin.tenantId);
      const fullPath = path.join(tenantDir, `pin_${this.sanitize(pin.scanId)}.json`);
      if (fs.existsSync(fullPath)) {
        const raw = await fs.promises.readFile(fullPath, "utf8");
        return JSON.parse(raw);
      }
      await fs.promises.writeFile(fullPath, JSON.stringify(pin, null, 2), "utf8");
      return pin;
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to save scan pin to disk",
        err,
      );
    }
  }

  async getScanPin(
    tenantId: string,
    scanId: string,
  ): Promise<GoldenSnapshotScanPin | undefined> {
    try {
      const tenantDir = this.getTenantDir(tenantId);
      const fullPath = path.join(tenantDir, `pin_${this.sanitize(scanId)}.json`);
      if (!fs.existsSync(fullPath)) return undefined;
      const raw = await fs.promises.readFile(fullPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new GoldenSnapshotError(
        "STORE_UNAVAILABLE",
        "Failed to read scan pin from disk",
        err,
      );
    }
  }
}
