export interface MergeQueueItem {
  id: string;
  prNumber: number;
  title: string;
  author: string;
  estimatedGasDelta: number;
  riskScore: 'low' | 'medium' | 'high' | 'critical';
  dependencies?: string[];
  conflictingFiles?: string[];
}

export interface MergeQueueAnalysisResult {
  queueId: string;
  totalItems: number;
  cumulativeGasDelta: number;
  highestRisk: 'low' | 'medium' | 'high' | 'critical';
  conflictsDetected: Array<{ pr1: number; pr2: number; file: string }>;
  passedValidation: boolean;
  timestamp: string;
}

export class MergeQueueAnalyzer {
  private maxCumulativeGasDelta: number;
  private failOnCriticalRisk: boolean;

  constructor(options?: {
    maxCumulativeGasDelta?: number;
    failOnCriticalRisk?: boolean;
  }) {
    this.maxCumulativeGasDelta = options?.maxCumulativeGasDelta ?? 500000;
    this.failOnCriticalRisk = options?.failOnCriticalRisk ?? true;
  }

  public analyzeQueue(
    queueId: string,
    items: MergeQueueItem[]
  ): MergeQueueAnalysisResult {
    let cumulativeGasDelta = 0;
    let highestRisk: MergeQueueAnalysisResult['highestRisk'] = 'low';

    const riskRank = { low: 1, medium: 2, high: 3, critical: 4 };
    const conflicts: Array<{ pr1: number; pr2: number; file: string }> = [];
    const fileOwners = new Map<string, number>();

    for (const item of items) {
      cumulativeGasDelta += item.estimatedGasDelta;

      if (riskRank[item.riskScore] > riskRank[highestRisk]) {
        highestRisk = item.riskScore;
      }

      for (const file of item.conflictingFiles ?? []) {
        const owner = fileOwners.get(file);

        if (owner !== undefined && owner !== item.prNumber) {
          conflicts.push({
            pr1: owner,
            pr2: item.prNumber,
            file,
          });
        } else {
          fileOwners.set(file, item.prNumber);
        }
      }
    }

    const passedValidation =
      !(this.failOnCriticalRisk && highestRisk === 'critical') &&
      cumulativeGasDelta <= this.maxCumulativeGasDelta &&
      conflicts.length === 0;

    return {
      queueId,
      totalItems: items.length,
      cumulativeGasDelta,
      highestRisk,
      conflictsDetected: conflicts,
      passedValidation,
      timestamp: new Date().toISOString(),
    };
  }
}
