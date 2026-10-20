import { QueuePressureMetrics } from '../types/scan-observability.types';

export class AnalyzerSaturationMetricsService {
  private activeWorkers = 0;
  private queuedJobs: { jobId: string; queuedAt: number }[] = [];
  private maxWorkers: number;

  constructor(maxWorkers = 10) {
    this.maxWorkers = maxWorkers;
  }

  public jobEnqueued(jobId: string, timestamp = Date.now()): void {
    this.queuedJobs.push({ jobId, queuedAt: timestamp });
  }

  public jobStarted(jobId: string): number {
    const index = this.queuedJobs.findIndex((j) => j.jobId === jobId);
    let waitTimeMs = 0;
    if (index !== -1) {
      waitTimeMs = Date.now() - this.queuedJobs[index].queuedAt;
      this.queuedJobs.splice(index, 1);
    }
    this.activeWorkers += 1;
    return waitTimeMs;
  }

  public jobFinished(): void {
    if (this.activeWorkers > 0) {
      this.activeWorkers -= 1;
    }
  }

  public getMetrics(): QueuePressureMetrics {
    const now = Date.now();
    const totalWaitMs = this.queuedJobs.reduce(
      (sum, j) => sum + (now - j.queuedAt),
      0,
    );
    const averageWaitTimeMs =
      this.queuedJobs.length > 0 ? totalWaitMs / this.queuedJobs.length : 0;
    const saturationRatio = this.activeWorkers / Math.max(1, this.maxWorkers);

    return {
      activeWorkers: this.activeWorkers,
      maxWorkers: this.maxWorkers,
      queuedJobs: this.queuedJobs.length,
      saturationRatio: Number(saturationRatio.toFixed(3)),
      isSaturated: saturationRatio >= 0.9,
      averageWaitTimeMs: Math.round(averageWaitTimeMs),
      timestamp: now,
    };
  }

  public clear(): void {
    this.activeWorkers = 0;
    this.queuedJobs = [];
  }
}
