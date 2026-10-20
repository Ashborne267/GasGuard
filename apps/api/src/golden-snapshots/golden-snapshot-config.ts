/**
 * Configuration options and environment loader for Golden Output Snapshots (#1253).
 */

import { GoldenSnapshotError } from "./golden-snapshot-types";

export interface GoldenSnapshotConfig {
  /** Master toggle / kill-switch for golden snapshot verification. */
  enabled: boolean;
  /** Directory where snapshot manifest JSON files are stored. */
  storageDir: string;
  /** Whether to fail scans or quality gates when snapshots mismatch. */
  enforceMatching: boolean;
  /** Allow auto-updating or generating missing snapshots in non-production environments. */
  autoUpdate: boolean;
  /** Maximum allowable diff count before aborting full diff computation. */
  maxDiffCount: number;
  /** Maximum snapshot payload size in bytes. */
  maxPayloadSizeBytes: number;
}

export const DEFAULT_GOLDEN_SNAPSHOT_CONFIG: GoldenSnapshotConfig = {
  enabled: true,
  storageDir: process.env.GOLDEN_SNAPSHOT_STORAGE_DIR || "./data/golden-snapshots",
  enforceMatching: process.env.GOLDEN_SNAPSHOT_ENFORCE_MATCHING === "true",
  autoUpdate: process.env.GOLDEN_SNAPSHOT_AUTO_UPDATE === "true",
  maxDiffCount: 500,
  maxPayloadSizeBytes: 10 * 1024 * 1024, // 10MB
};

export function loadGoldenSnapshotConfig(
  env: Record<string, string | undefined> = process.env,
): GoldenSnapshotConfig {
  const enabled =
    env.GOLDEN_SNAPSHOT_ENABLED !== undefined
      ? env.GOLDEN_SNAPSHOT_ENABLED !== "false" && env.GOLDEN_SNAPSHOT_ENABLED !== "0"
      : DEFAULT_GOLDEN_SNAPSHOT_CONFIG.enabled;

  const storageDir =
    env.GOLDEN_SNAPSHOT_STORAGE_DIR || DEFAULT_GOLDEN_SNAPSHOT_CONFIG.storageDir;

  const enforceMatching =
    env.GOLDEN_SNAPSHOT_ENFORCE_MATCHING !== undefined
      ? env.GOLDEN_SNAPSHOT_ENFORCE_MATCHING === "true" || env.GOLDEN_SNAPSHOT_ENFORCE_MATCHING === "1"
      : DEFAULT_GOLDEN_SNAPSHOT_CONFIG.enforceMatching;

  const autoUpdate =
    env.GOLDEN_SNAPSHOT_AUTO_UPDATE !== undefined
      ? env.GOLDEN_SNAPSHOT_AUTO_UPDATE === "true" || env.GOLDEN_SNAPSHOT_AUTO_UPDATE === "1"
      : DEFAULT_GOLDEN_SNAPSHOT_CONFIG.autoUpdate;

  let maxDiffCount = DEFAULT_GOLDEN_SNAPSHOT_CONFIG.maxDiffCount;
  if (env.GOLDEN_SNAPSHOT_MAX_DIFF_COUNT) {
    const parsed = parseInt(env.GOLDEN_SNAPSHOT_MAX_DIFF_COUNT, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new GoldenSnapshotError(
        "INVALID_CONFIG",
        `GOLDEN_SNAPSHOT_MAX_DIFF_COUNT must be a positive integer, got '${env.GOLDEN_SNAPSHOT_MAX_DIFF_COUNT}'`,
      );
    }
    maxDiffCount = parsed;
  }

  let maxPayloadSizeBytes = DEFAULT_GOLDEN_SNAPSHOT_CONFIG.maxPayloadSizeBytes;
  if (env.GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE) {
    const parsed = parseInt(env.GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new GoldenSnapshotError(
        "INVALID_CONFIG",
        `GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE must be a positive integer, got '${env.GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE}'`,
      );
    }
    maxPayloadSizeBytes = parsed;
  }

  return {
    enabled,
    storageDir,
    enforceMatching,
    autoUpdate,
    maxDiffCount,
    maxPayloadSizeBytes,
  };
}
