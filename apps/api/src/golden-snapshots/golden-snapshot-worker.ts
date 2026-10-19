/**
 * Worker-side adapter for Golden Output Snapshots (#1253).
 *
 * Integrates snapshot verification into repository scanning pipelines
 * and converts raw engine AnalysisResults into canonical snapshot formats.
 */

import { AnalysisResult } from "../../../../libs/engine/core/analyzer-interface";
import { GoldenSnapshotService } from "./golden-snapshot.service";
import {
  LanguageGoldenOutput,
  GoldenFindingSnapshot,
  SnapshotVerificationResult,
} from "./golden-snapshot-types";

export interface GoldenSnapshotWorkerTask {
  tenantId: string;
  scanId: string;
  repositoryId: string;
  commitHash: string;
  rulePackVersion: string;
  /** Language -> AnalysisResult from analyzer runner */
  analysisResults: Record<string, AnalysisResult>;
}

export function transformAnalysisResultToGoldenOutput(
  language: string,
  result: AnalysisResult,
): LanguageGoldenOutput {
  const findings: GoldenFindingSnapshot[] = (result.findings || []).map((f) => ({
    ruleId: f.ruleId,
    message: f.message,
    severity: f.severity,
    location: {
      file: f.location.file,
      startLine: f.location.startLine,
      endLine: f.location.endLine,
      startColumn: f.location.startColumn,
      endColumn: f.location.endColumn,
    },
    estimatedGasSavings: f.estimatedGasSavings,
    metadata: f.metadata,
  }));

  return {
    language,
    filesAnalyzed: result.filesAnalyzed ?? 0,
    findings,
    summary: {
      critical: result.summary?.critical ?? 0,
      high: result.summary?.high ?? 0,
      medium: result.summary?.medium ?? 0,
      low: result.summary?.low ?? 0,
      info: result.summary?.info ?? 0,
    },
    totalEstimatedGasSavings: result.totalEstimatedGasSavings,
  };
}

export async function processGoldenSnapshotVerification(
  service: GoldenSnapshotService,
  task: GoldenSnapshotWorkerTask,
): Promise<SnapshotVerificationResult> {
  const actualOutputs: Record<string, LanguageGoldenOutput> = {};

  for (const [lang, result] of Object.entries(task.analysisResults)) {
    actualOutputs[lang] = transformAnalysisResultToGoldenOutput(lang, result);
  }

  return service.verifyOutputs({
    tenantId: task.tenantId,
    scanId: task.scanId,
    repositoryId: task.repositoryId,
    commitHash: task.commitHash,
    rulePackVersion: task.rulePackVersion,
    actualOutputs,
  });
}
