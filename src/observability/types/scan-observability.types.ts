/**
 * Types for Scan Observability, Throughput Dashboard, Saturation Metrics,
 * Stage Duration Histograms, and Failure Taxonomy (#1259, #1260, #1261, #1264).
 */

export type ScanStage =
  | 'cloning'
  | 'ast_generation'
  | 'rule_evaluation'
  | 'fingerprinting'
  | 'reporting'
  | 'persisting';

export interface StageHistogramBucket {
  le: number; // upper bound in milliseconds
  count: number;
}

export interface StageDurationHistogram {
  stage: ScanStage;
  count: number;
  sumMs: number;
  buckets: StageHistogramBucket[];
}

export interface QueuePressureMetrics {
  activeWorkers: number;
  maxWorkers: number;
  queuedJobs: number;
  saturationRatio: number; // activeWorkers / maxWorkers
  isSaturated: boolean;
  averageWaitTimeMs: number;
  timestamp: number;
}

export type ScanFailureCategory =
  | 'SYNTAX_ERROR'
  | 'TIMEOUT'
  | 'RESOURCE_EXHAUSTION'
  | 'RULE_EXECUTION_FAILURE'
  | 'DEPENDENCY_RESOLVE_ERROR'
  | 'NETWORK_IO_ERROR'
  | 'INTERNAL_ERROR';

export interface StructuredScanFailure {
  failureId: string;
  scanId: string;
  tenantId: string;
  category: ScanFailureCategory;
  errorCode: string;
  message: string;
  stage: ScanStage;
  retryable: boolean;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface ScanThroughputRecord {
  scanId: string;
  tenantId: string;
  repository: string;
  filesScanned: number;
  durationMs: number;
  timestamp: number;
  success: boolean;
}

export interface ThroughputDashboardSummary {
  windowMs: number;
  totalScans: number;
  successfulScans: number;
  failedScans: number;
  successRate: number;
  totalFilesScanned: number;
  scansPerMinute: number;
  filesPerSecond: number;
  avgDurationMs: number;
}
