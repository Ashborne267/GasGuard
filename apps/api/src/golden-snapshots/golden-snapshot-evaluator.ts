/**
 * Pure evaluator for Golden Output Snapshots (#1253).
 *
 * Enforces determinism, canonical sorting, diffing, and hashing across supported languages.
 */

import {
  GoldenSnapshotManifest,
  GoldenFindingSnapshot,
  LanguageGoldenOutput,
  SnapshotVerificationResult,
  LanguageDiffResult,
  FindingDiff,
  GoldenSnapshotError,
} from "./golden-snapshot-types";

export const GOLDEN_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Normalizes and sorts finding records canonically by file -> startLine -> startColumn -> ruleId -> message.
 */
export function canonicalizeFindings(
  findings: GoldenFindingSnapshot[],
): GoldenFindingSnapshot[] {
  return [...findings].sort((a, b) => {
    if (a.location.file !== b.location.file) {
      return a.location.file.localeCompare(b.location.file);
    }
    if (a.location.startLine !== b.location.startLine) {
      return a.location.startLine - b.location.startLine;
    }
    const aCol = a.location.startColumn ?? 0;
    const bCol = b.location.startColumn ?? 0;
    if (aCol !== bCol) {
      return aCol - bCol;
    }
    if (a.ruleId !== b.ruleId) {
      return a.ruleId.localeCompare(b.ruleId);
    }
    return a.message.localeCompare(b.message);
  });
}

/**
 * Computes a deterministic SHA-256 equivalent djb2 hex fingerprint over structured language outputs.
 */
export function computeSnapshotFingerprint(
  tenantId: string,
  repositoryId: string,
  commitHash: string,
  rulePackVersion: string,
  languageOutputs: Record<string, LanguageGoldenOutput>,
): string {
  const sortedLanguages = Object.keys(languageOutputs).sort();
  const tokens: string[] = [
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
  ];

  for (const lang of sortedLanguages) {
    const out = languageOutputs[lang];
    const canonical = canonicalizeFindings(out.findings);
    const summaryStr = `${out.summary.critical}:${out.summary.high}:${out.summary.medium}:${out.summary.low}:${out.summary.info}`;
    const findingsStr = canonical
      .map(
        (f) =>
          `${f.ruleId}@${f.location.file}:${f.location.startLine}:${f.severity}:${f.message.trim()}`,
      )
      .join("|");
    tokens.push(
      `lang=${lang};files=${out.filesAnalyzed};summary=${summaryStr};gas=${out.totalEstimatedGasSavings ?? 0};findings=[${findingsStr}]`,
    );
  }

  const raw = tokens.join("::");

  // Deterministic fast hash
  let hash1 = 5381;
  let hash2 = 52711;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash1 = ((hash1 << 5) + hash1) ^ char;
    hash2 = ((hash2 << 5) + hash2) ^ char;
  }
  const part1 = (hash1 >>> 0).toString(16).padStart(8, "0");
  const part2 = (hash2 >>> 0).toString(16).padStart(8, "0");
  return `${part1}${part2}`;
}

/**
 * Generates a complete canonical GoldenSnapshotManifest from language analysis outputs.
 */
export function createSnapshotManifest(params: {
  tenantId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  languageOutputs: Record<string, LanguageGoldenOutput>;
  clock?: () => number;
  metadata?: Record<string, unknown>;
}): GoldenSnapshotManifest {
  const { tenantId, repositoryId, commitHash, rulePackVersion, languageOutputs } = params;

  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new GoldenSnapshotError("INVALID_INPUT", "tenantId must be a non-empty string");
  }
  if (!repositoryId || typeof repositoryId !== "string" || repositoryId.trim() === "") {
    throw new GoldenSnapshotError("INVALID_INPUT", "repositoryId must be a non-empty string");
  }
  if (!commitHash || typeof commitHash !== "string" || commitHash.trim() === "") {
    throw new GoldenSnapshotError("INVALID_INPUT", "commitHash must be a non-empty string");
  }
  if (!rulePackVersion || typeof rulePackVersion !== "string" || rulePackVersion.trim() === "") {
    throw new GoldenSnapshotError("INVALID_INPUT", "rulePackVersion must be a non-empty string");
  }

  const clock = params.clock ?? (() => Date.now());
  const normalizedOutputs: Record<string, LanguageGoldenOutput> = {};
  const sortedLangs = Object.keys(languageOutputs).sort();

  for (const lang of sortedLangs) {
    const output = languageOutputs[lang];
    normalizedOutputs[lang] = {
      language: lang,
      filesAnalyzed: output.filesAnalyzed,
      findings: canonicalizeFindings(output.findings),
      summary: { ...output.summary },
      totalEstimatedGasSavings: output.totalEstimatedGasSavings,
    };
  }

  const fingerprint = computeSnapshotFingerprint(
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
    normalizedOutputs,
  );

  const snapshotId = `golden-${repositoryId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${commitHash.slice(0, 12)}-${fingerprint.slice(0, 8)}`;

  return {
    schemaVersion: GOLDEN_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    tenantId,
    repositoryId,
    commitHash,
    rulePackVersion,
    supportedLanguages: sortedLangs,
    createdAt: clock(),
    fingerprint,
    languageOutputs: normalizedOutputs,
    metadata: params.metadata,
  };
}

/**
 * Compares an actual set of language analysis outputs against a golden snapshot manifest.
 */
export function verifySnapshotAgainstOutputs(params: {
  goldenManifest: GoldenSnapshotManifest;
  actualOutputs: Record<string, LanguageGoldenOutput>;
  maxDiffs?: number;
  clock?: () => number;
}): SnapshotVerificationResult {
  const { goldenManifest, actualOutputs } = params;
  const maxDiffs = params.maxDiffs ?? 500;
  const clock = params.clock ?? (() => Date.now());

  const actualFingerprint = computeSnapshotFingerprint(
    goldenManifest.tenantId,
    goldenManifest.repositoryId,
    goldenManifest.commitHash,
    goldenManifest.rulePackVersion,
    actualOutputs,
  );

  const languageResults: Record<string, LanguageDiffResult> = {};
  let totalDifferences = 0;

  // Union of languages in golden and actual
  const allLanguages = Array.from(
    new Set([...goldenManifest.supportedLanguages, ...Object.keys(actualOutputs)]),
  ).sort();

  for (const lang of allLanguages) {
    const expected = goldenManifest.languageOutputs[lang];
    const actual = actualOutputs[lang];

    const findingDiffs: FindingDiff[] = [];

    if (!expected && actual) {
      totalDifferences++;
      findingDiffs.push({
        type: "added",
        ruleId: "*",
        file: "*",
        line: 0,
        message: `Unexpected analysis output for language '${lang}' not in golden snapshot`,
      });
      languageResults[lang] = {
        language: lang,
        matched: false,
        findingDiffs,
      };
      continue;
    }

    if (expected && !actual) {
      totalDifferences++;
      findingDiffs.push({
        type: "removed",
        ruleId: "*",
        file: "*",
        line: 0,
        message: `Missing analysis output for language '${lang}' defined in golden snapshot`,
      });
      languageResults[lang] = {
        language: lang,
        matched: false,
        findingDiffs,
      };
      continue;
    }

    if (expected && actual) {
      // Compare filesAnalyzed
      let filesAnalyzedDiff: LanguageDiffResult["filesAnalyzedDiff"];
      if (expected.filesAnalyzed !== actual.filesAnalyzed) {
        filesAnalyzedDiff = {
          expected: expected.filesAnalyzed,
          actual: actual.filesAnalyzed,
        };
        totalDifferences++;
      }

      // Compare summary
      let summaryDiff: LanguageDiffResult["summaryDiff"];
      const sumE = expected.summary;
      const sumA = actual.summary;
      if (
        sumE.critical !== sumA.critical ||
        sumE.high !== sumA.high ||
        sumE.medium !== sumA.medium ||
        sumE.low !== sumA.low ||
        sumE.info !== sumA.info
      ) {
        summaryDiff = { expected: sumE, actual: sumA };
        totalDifferences++;
      }

      // Compare findings
      const expCanonical = canonicalizeFindings(expected.findings);
      const actCanonical = canonicalizeFindings(actual.findings);

      const expMap = new Map<string, GoldenFindingSnapshot>();
      for (const f of expCanonical) {
        const key = `${f.ruleId}::${f.location.file}::${f.location.startLine}::${f.message.trim()}`;
        expMap.set(key, f);
      }

      const actMap = new Map<string, GoldenFindingSnapshot>();
      for (const f of actCanonical) {
        const key = `${f.ruleId}::${f.location.file}::${f.location.startLine}::${f.message.trim()}`;
        actMap.set(key, f);
      }

      // Check for removed findings
      for (const [key, expFinding] of expMap.entries()) {
        if (!actMap.has(key)) {
          if (findingDiffs.length < maxDiffs) {
            findingDiffs.push({
              type: "removed",
              ruleId: expFinding.ruleId,
              file: expFinding.location.file,
              line: expFinding.location.startLine,
              expected: expFinding,
              message: `Expected finding '${expFinding.ruleId}' at ${expFinding.location.file}:${expFinding.location.startLine} was not found`,
            });
          }
          totalDifferences++;
        }
      }

      // Check for added findings
      for (const [key, actFinding] of actMap.entries()) {
        if (!expMap.has(key)) {
          if (findingDiffs.length < maxDiffs) {
            findingDiffs.push({
              type: "added",
              ruleId: actFinding.ruleId,
              file: actFinding.location.file,
              line: actFinding.location.startLine,
              actual: actFinding,
              message: `Unexpected finding '${actFinding.ruleId}' at ${actFinding.location.file}:${actFinding.location.startLine}`,
            });
          }
          totalDifferences++;
        }
      }

      const matched =
        totalDifferences === 0 &&
        findingDiffs.length === 0 &&
        !summaryDiff &&
        !filesAnalyzedDiff;

      languageResults[lang] = {
        language: lang,
        matched,
        findingDiffs,
        summaryDiff,
        filesAnalyzedDiff,
      };
    }
  }

  const matched = totalDifferences === 0 && actualFingerprint === goldenManifest.fingerprint;

  return {
    status: matched ? "matched" : "mismatched",
    matched,
    tenantId: goldenManifest.tenantId,
    repositoryId: goldenManifest.repositoryId,
    commitHash: goldenManifest.commitHash,
    rulePackVersion: goldenManifest.rulePackVersion,
    expectedFingerprint: goldenManifest.fingerprint,
    actualFingerprint,
    languageResults,
    totalDifferences,
    verifiedAt: clock(),
  };
}
