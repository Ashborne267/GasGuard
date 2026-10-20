import {
  ScanStage,
  StageDurationHistogram,
} from '../types/scan-observability.types';

export const DEFAULT_DURATION_BUCKETS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];

export class ScanStageHistogramService {
  private histograms = new Map<
    ScanStage,
    { count: number; sumMs: number; buckets: Map<number, number> }
  >();
  private bucketBoundaries: number[];

  constructor(bucketBoundaries: number[] = DEFAULT_DURATION_BUCKETS) {
    this.bucketBoundaries = [...bucketBoundaries].sort((a, b) => a - b);
  }

  public recordStageDuration(stage: ScanStage, durationMs: number): void {
    let stageData = this.histograms.get(stage);
    if (!stageData) {
      stageData = {
        count: 0,
        sumMs: 0,
        buckets: new Map<number, number>(),
      };
      for (const le of this.bucketBoundaries) {
        stageData.buckets.set(le, 0);
      }
      this.histograms.set(stage, stageData);
    }

    stageData.count += 1;
    stageData.sumMs += durationMs;

    for (const le of this.bucketBoundaries) {
      if (durationMs <= le) {
        const current = stageData.buckets.get(le) ?? 0;
        stageData.buckets.set(le, current + 1);
      }
    }
  }

  public getHistogram(stage: ScanStage): StageDurationHistogram | null {
    const stageData = this.histograms.get(stage);
    if (!stageData) return null;

    const buckets = this.bucketBoundaries.map((le) => ({
      le,
      count: stageData.buckets.get(le) ?? 0,
    }));

    return {
      stage,
      count: stageData.count,
      sumMs: stageData.sumMs,
      buckets,
    };
  }

  public clear(): void {
    this.histograms.clear();
  }
}
