import {
  ScanThroughputRecord,
  ThroughputDashboardSummary,
} from '../types/scan-observability.types';

export class ScanThroughputDashboardService {
  private records: ScanThroughputRecord[] = [];

  public recordScan(record: ScanThroughputRecord): void {
    this.records.push(record);
  }

  public getSummary(
    windowMs = 3600000,
    tenantId?: string,
  ): ThroughputDashboardSummary {
    const now = Date.now();
    const startTime = now - windowMs;

    let relevant = this.records.filter((r) => r.timestamp >= startTime);
    if (tenantId) {
      relevant = relevant.filter((r) => r.tenantId === tenantId);
    }

    const totalScans = relevant.length;
    const successfulScans = relevant.filter((r) => r.success).length;
    const failedScans = totalScans - successfulScans;
    const successRate = totalScans > 0 ? (successfulScans / totalScans) * 100 : 0;
    const totalFilesScanned = relevant.reduce((sum, r) => sum + r.filesScanned, 0);
    const totalDurationMs = relevant.reduce((sum, r) => sum + r.durationMs, 0);

    const windowMinutes = Math.max(1, windowMs / 60000);
    const windowSeconds = Math.max(1, windowMs / 1000);

    const scansPerMinute = Number((totalScans / windowMinutes).toFixed(2));
    const filesPerSecond = Number((totalFilesScanned / windowSeconds).toFixed(2));
    const avgDurationMs = totalScans > 0 ? Math.round(totalDurationMs / totalScans) : 0;

    return {
      windowMs,
      totalScans,
      successfulScans,
      failedScans,
      successRate: Number(successRate.toFixed(2)),
      totalFilesScanned,
      scansPerMinute,
      filesPerSecond,
      avgDurationMs,
    };
  }

  public clear(): void {
    this.records = [];
  }
}
