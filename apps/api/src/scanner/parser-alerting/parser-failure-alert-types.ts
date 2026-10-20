/**
 * Parser Failure Alerting Types (#1262).
 *
 * Defines configuration, tracking, and alerting models for repeated AST parser
 * failures across repositories under strict tenant isolation.
 */

export type ParserLanguage =
  | "solidity"
  | "vyper"
  | "rust"
  | "soroban"
  | "unsupported";

export type ParserFailureCategory =
  | "syntax_error"
  | "recursion_limit"
  | "unsupported_syntax"
  | "worker_crash"
  | "timeout";

export type AlertSeverity = "warning" | "critical";

export type AlertStatus = "active" | "resolved" | "suppressed";

export interface ParserScanRecord {
  scanId: string;
  tenantId: string;
  repositoryUrl: string;
  commitHash: string;
  language: ParserLanguage;
  parserName: string;
  timestamp: number;
  hasFailed: boolean;
  failureCategory?: ParserFailureCategory;
  diagnosticCodes?: string[];
  errorSummary?: string;
}

export interface ParserAlertConfig {
  /** Consecutive parser failures on repository before raising alert (e.g. 3). */
  consecutiveFailuresThreshold: number;
  /** Sliding window failure ratio [0, 1] that triggers alert (e.g. 0.4 = 40%). */
  failureRatioThreshold: number;
  /** Number of recent scans kept in sliding window for ratio evaluation (e.g. 10). */
  windowSize: number;
  /** Minimum scans in window before evaluating ratio threshold (e.g. 4). */
  minScansForRatio: number;
  /** Quiet period in ms between alert dispatches for same repository (e.g. 300,000ms / 5 min). */
  cooldownPeriodMs: number;
  /** Consecutive successful parses required to automatically resolve active alert (e.g. 2). */
  autoResolveConsecutiveSuccesses: number;
}

export const DEFAULT_PARSER_ALERT_CONFIG: ParserAlertConfig = {
  consecutiveFailuresThreshold: 3,
  failureRatioThreshold: 0.4,
  windowSize: 10,
  minScansForRatio: 4,
  cooldownPeriodMs: 5 * 60 * 1000, // 5 minutes
  autoResolveConsecutiveSuccesses: 2,
};

export interface ParserAlert {
  alertId: string;
  tenantId: string;
  repositoryUrl: string;
  language: ParserLanguage;
  parserName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  triggerReason: string;
  consecutiveFailures: number;
  failureRatio: number;
  recentScansCount: number;
  diagnosticCodesSummary: Record<string, number>;
  firstTriggeredAt: number;
  lastTriggeredAt: number;
  resolvedAt?: number;
  notificationCount: number;
}

export interface ParserAlertMetrics {
  totalScansEvaluated: number;
  totalFailuresRecorded: number;
  activeAlertsCount: number;
  totalAlertsDispatched: number;
  totalAlertsResolved: number;
}

export interface AlertNotificationHandler {
  onAlert(alert: ParserAlert): Promise<void> | void;
}
