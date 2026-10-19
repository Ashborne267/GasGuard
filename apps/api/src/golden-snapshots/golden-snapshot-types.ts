/**
 * Shared types for golden output snapshots for supported languages (#1253).
 *
 * Provides deterministic capture, verification, and persistence of canonical
 * golden output snapshots for repository analysis across supported languages.
 */

import { Language } from "../../../../libs/engine/core/analyzer-interface";

export const SNAPSHOT_STATUSES = ["matched", "mismatched", "missing"] as const;
export type GoldenSnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export interface FindingLocationSnapshot {
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface GoldenFindingSnapshot {
  ruleId: string;
  message: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  location: FindingLocationSnapshot;
  estimatedGasSavings?: number;
  metadata?: Record<string, unknown>;
}

export interface LanguageGoldenOutput {
  language: Language | string;
  filesAnalyzed: number;
  findings: GoldenFindingSnapshot[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  totalEstimatedGasSavings?: number;
}

export interface GoldenSnapshotManifest {
  schemaVersion: number;
  snapshotId: string;
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  supportedLanguages: string[];
  createdAt: number;
  fingerprint: string;
  languageOutputs: Record<string, LanguageGoldenOutput>;
  metadata?: Record<string, unknown>;
}

export interface FindingDiff {
  type: "added" | "removed" | "modified";
  ruleId: string;
  file: string;
  line: number;
  expected?: Partial<GoldenFindingSnapshot>;
  actual?: Partial<GoldenFindingSnapshot>;
  message: string;
}

export interface LanguageDiffResult {
  language: string;
  matched: boolean;
  findingDiffs: FindingDiff[];
  summaryDiff?: {
    expected: LanguageGoldenOutput["summary"];
    actual: LanguageGoldenOutput["summary"];
  };
  filesAnalyzedDiff?: {
    expected: number;
    actual: number;
  };
}

export interface SnapshotVerificationResult {
  status: GoldenSnapshotStatus;
  matched: boolean;
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  expectedFingerprint: string;
  actualFingerprint: string;
  languageResults: Record<string, LanguageDiffResult>;
  totalDifferences: number;
  verifiedAt: number;
}

export interface GoldenSnapshotScanPin {
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  snapshotId: string;
  pinnedAt: number;
  fingerprint: string;
}

export type GoldenSnapshotErrorCode =
  | "SNAPSHOT_DISABLED"
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "STORE_UNAVAILABLE"
  | "STORE_CONFLICT"
  | "UNSUPPORTED_LANGUAGE"
  | "SNAPSHOT_NOT_FOUND"
  | "PARSE_ERROR";

export class GoldenSnapshotError extends Error {
  constructor(
    public readonly code: GoldenSnapshotErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "GoldenSnapshotError";
  }
}
