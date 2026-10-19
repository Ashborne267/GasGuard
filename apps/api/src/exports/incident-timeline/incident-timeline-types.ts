/**
 * Incident Timeline Export Types (#1265).
 *
 * Captures chronological event histories, worker lifecycles, and failure diagnostics
 * for failed and aborted repository scans under strict tenant isolation.
 */

export type TimelineEventType =
  | "scan_created"
  | "worker_assigned"
  | "lease_acquired"
  | "stage_started"
  | "checkpoint_recorded"
  | "file_parsed"
  | "parser_warning"
  | "parser_error"
  | "analyzer_invoked"
  | "analyzer_failed"
  | "resource_limit_exceeded"
  | "network_timeout"
  | "worker_heartbeat_missed"
  | "worker_crashed"
  | "lease_expired"
  | "scan_aborted"
  | "scan_failed"
  | "scan_recovered";

export type TimelineEventSeverity = "info" | "warn" | "error" | "critical";

export type FailureCategory =
  | "PARSER_FAILURE"
  | "RESOURCE_EXHAUSTION"
  | "TIMEOUT"
  | "LEASE_EXPIRED"
  | "UNSUPPORTED_LANGUAGE"
  | "INTERNAL_ERROR"
  | "SECURITY_VIOLATION";

export interface TimelineErrorDetails {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  stackExcerpt?: string;
}

export interface TimelineEvent {
  eventId: string;
  scanId: string;
  tenantId: string;
  timestamp: number;
  type: TimelineEventType;
  severity: TimelineEventSeverity;
  stage: string;
  actor: string;
  message: string;
  metadata?: Record<string, unknown>;
  errorDetails?: TimelineErrorDetails;
}

export interface DiagnosticsCount {
  recovered: number;
  unrecovered: number;
  total: number;
}

export interface WorkerLifecycleSummary {
  workerId: string;
  leaseAcquiredAt?: number;
  lastHeartbeatAt?: number;
  leaseFencingToken?: number;
  releasedAt?: number;
}

export interface ScanIncidentRecord {
  incidentId: string;
  scanId: string;
  tenantId: string;
  repositoryUrl: string;
  commitHash: string;
  failureCategory: FailureCategory;
  summary: string;
  startedAt: number;
  failedAt: number;
  durationMs: number;
  workerLifecycle?: WorkerLifecycleSummary;
  diagnosticsCount?: DiagnosticsCount;
  status: "failed" | "aborted" | "recovered";
  events: TimelineEvent[];
}

export type ExportFormat = "json" | "markdown" | "csv";

export interface IncidentExportResult {
  format: ExportFormat;
  contentType: string;
  filename: string;
  data: string;
  metadata: {
    scanId: string;
    incidentId: string;
    tenantId: string;
    eventCount: number;
    generatedAt: string;
  };
}

export interface IncidentTimelineStoreConfig {
  maxIncidentsPerTenant: number;
  maxEventsPerIncident: number;
  ttlMs: number;
}

export const DEFAULT_INCIDENT_STORE_CONFIG: IncidentTimelineStoreConfig = {
  maxIncidentsPerTenant: 50,
  maxEventsPerIncident: 200,
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
