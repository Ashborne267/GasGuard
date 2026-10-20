import {
  DEFAULT_PARSER_ALERT_CONFIG,
  ParserAlert,
  ParserAlertConfig,
  ParserLanguage,
  ParserScanRecord,
} from "./parser-failure-alert-types";

export function resolveParserAlertConfig(
  overrides?: Partial<ParserAlertConfig>,
): ParserAlertConfig {
  if (!overrides) {
    return { ...DEFAULT_PARSER_ALERT_CONFIG };
  }

  const resolved = { ...DEFAULT_PARSER_ALERT_CONFIG, ...overrides };

  const positiveIntegers: Array<keyof ParserAlertConfig> = [
    "consecutiveFailuresThreshold",
    "windowSize",
    "minScansForRatio",
    "cooldownPeriodMs",
    "autoResolveConsecutiveSuccesses",
  ];

  for (const field of positiveIntegers) {
    const val = resolved[field];
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      throw new RangeError(`${field} must be a positive integer`);
    }
  }

  if (
    typeof resolved.failureRatioThreshold !== "number" ||
    Number.isNaN(resolved.failureRatioThreshold) ||
    resolved.failureRatioThreshold <= 0 ||
    resolved.failureRatioThreshold > 1
  ) {
    throw new RangeError(
      "failureRatioThreshold must be a number between 0 and 1",
    );
  }

  if (resolved.minScansForRatio > resolved.windowSize) {
    throw new RangeError("minScansForRatio cannot exceed windowSize");
  }

  return resolved;
}

interface TrackedCohortState {
  tenantId: string;
  repositoryUrl: string;
  language: ParserLanguage;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  history: ParserScanRecord[];
  activeAlert?: ParserAlert;
  diagnosticCodes: Record<string, number>;
}

export class ParserFailureAlertTracker {
  private readonly config: ParserAlertConfig;
  private readonly clock: () => number;
  // Key: `${tenantId}::${repositoryUrl}::${language}`
  private readonly cohorts: Map<string, TrackedCohortState> = new Map();
  private readonly alertHistory: ParserAlert[] = [];

  constructor(
    config?: Partial<ParserAlertConfig>,
    clock: () => number = Date.now,
  ) {
    this.config = resolveParserAlertConfig(config);
    this.clock = clock;
  }

  getConfig(): ParserAlertConfig {
    return { ...this.config };
  }

  /**
   * Records a parser scan execution outcome and evaluates alerting rules deterministically.
   */
  recordScan(record: ParserScanRecord): {
    alertTriggered?: ParserAlert;
    alertResolved?: ParserAlert;
    isSuppressed: boolean;
  } {
    this.validateRecord(record);

    const key = this.buildKey(
      record.tenantId,
      record.repositoryUrl,
      record.language,
    );
    let cohort = this.cohorts.get(key);
    if (!cohort) {
      cohort = {
        tenantId: record.tenantId,
        repositoryUrl: record.repositoryUrl,
        language: record.language,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        history: [],
        diagnosticCodes: {},
      };
      this.cohorts.set(key, cohort);
    }

    const now = this.clock();

    // Append to sliding window
    cohort.history.push(record);
    if (cohort.history.length > this.config.windowSize) {
      cohort.history.shift();
    }

    // Aggregate diagnostic codes
    if (record.diagnosticCodes) {
      for (const code of record.diagnosticCodes) {
        if (code && typeof code === "string") {
          cohort.diagnosticCodes[code] =
            (cohort.diagnosticCodes[code] ?? 0) + 1;
        }
      }
    }

    if (!record.hasFailed) {
      // Successful parse
      cohort.consecutiveSuccesses += 1;
      cohort.consecutiveFailures = 0;

      // Check auto-resolution of active alert
      if (
        cohort.activeAlert &&
        cohort.consecutiveSuccesses >=
          this.config.autoResolveConsecutiveSuccesses
      ) {
        const resolvedAlert: ParserAlert = {
          ...cohort.activeAlert,
          status: "resolved",
          resolvedAt: now,
        };
        const idx = this.alertHistory.findIndex(
          (a) => a.alertId === cohort.activeAlert?.alertId,
        );
        if (idx >= 0) {
          this.alertHistory[idx] = resolvedAlert;
        } else {
          this.alertHistory.push(resolvedAlert);
        }
        cohort.activeAlert = undefined;
        return { alertResolved: resolvedAlert, isSuppressed: false };
      }

      return { isSuppressed: false };
    }

    // Failed parse
    cohort.consecutiveFailures += 1;
    cohort.consecutiveSuccesses = 0;

    const failedCount = cohort.history.filter((s) => s.hasFailed).length;
    const failureRatio = failedCount / cohort.history.length;

    let triggerReason: string | undefined;
    if (
      cohort.consecutiveFailures >= this.config.consecutiveFailuresThreshold
    ) {
      triggerReason = `Consecutive parser failures (${cohort.consecutiveFailures}) reached threshold (${this.config.consecutiveFailuresThreshold})`;
    } else if (
      cohort.history.length >= this.config.minScansForRatio &&
      failureRatio >= this.config.failureRatioThreshold
    ) {
      triggerReason = `Parser failure ratio (${Math.round(failureRatio * 100)}%) breached threshold (${Math.round(this.config.failureRatioThreshold * 100)}%) across ${cohort.history.length} scans`;
    }

    if (!triggerReason) {
      return { isSuppressed: false };
    }

    const severity =
      cohort.consecutiveFailures >= this.config.consecutiveFailuresThreshold * 2
        ? "critical"
        : "warning";

    // Check if active alert already exists (cooldown suppression check)
    if (cohort.activeAlert) {
      const elapsedSinceTrigger = now - cohort.activeAlert.lastTriggeredAt;
      if (elapsedSinceTrigger < this.config.cooldownPeriodMs) {
        // Cooldown active: suppress notification flood
        cohort.activeAlert.notificationCount += 1;
        cohort.activeAlert.consecutiveFailures = cohort.consecutiveFailures;
        cohort.activeAlert.failureRatio = Math.round(failureRatio * 100) / 100;
        return { isSuppressed: true };
      }

      // Cooldown expired: re-dispatch alert with updated stats
      cohort.activeAlert.lastTriggeredAt = now;
      cohort.activeAlert.consecutiveFailures = cohort.consecutiveFailures;
      cohort.activeAlert.failureRatio = Math.round(failureRatio * 100) / 100;
      cohort.activeAlert.notificationCount += 1;
      cohort.activeAlert.severity = severity;
      cohort.activeAlert.triggerReason = triggerReason;

      return { alertTriggered: cohort.activeAlert, isSuppressed: false };
    }

    // Brand new alert
    const alertId = `alert-${record.tenantId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const newAlert: ParserAlert = {
      alertId,
      tenantId: record.tenantId,
      repositoryUrl: record.repositoryUrl,
      language: record.language,
      parserName: record.parserName,
      severity,
      status: "active",
      triggerReason,
      consecutiveFailures: cohort.consecutiveFailures,
      failureRatio: Math.round(failureRatio * 100) / 100,
      recentScansCount: cohort.history.length,
      diagnosticCodesSummary: { ...cohort.diagnosticCodes },
      firstTriggeredAt: now,
      lastTriggeredAt: now,
      notificationCount: 1,
    };

    cohort.activeAlert = newAlert;
    this.alertHistory.push(newAlert);

    return { alertTriggered: newAlert, isSuppressed: false };
  }

  getActiveAlerts(tenantId?: string): ParserAlert[] {
    const alerts: ParserAlert[] = [];
    for (const cohort of this.cohorts.values()) {
      if (cohort.activeAlert) {
        if (!tenantId || cohort.tenantId === tenantId) {
          alerts.push(cohort.activeAlert);
        }
      }
    }
    return alerts;
  }

  getAlertHistory(tenantId: string): ParserAlert[] {
    if (!tenantId || typeof tenantId !== "string") {
      throw new TypeError("tenantId must be a non-empty string");
    }
    return this.alertHistory.filter((a) => a.tenantId === tenantId);
  }

  clear(): void {
    this.cohorts.clear();
    this.alertHistory.length = 0;
  }

  private buildKey(
    tenantId: string,
    repositoryUrl: string,
    language: string,
  ): string {
    return `${tenantId.trim()}::${repositoryUrl.trim()}::${language.trim()}`;
  }

  private validateRecord(record: ParserScanRecord): void {
    if (!record || typeof record !== "object") {
      throw new TypeError("record must be a valid object");
    }
    if (
      !record.tenantId ||
      typeof record.tenantId !== "string" ||
      record.tenantId.trim() === ""
    ) {
      throw new TypeError("record.tenantId must be a non-empty string");
    }
    if (
      !record.repositoryUrl ||
      typeof record.repositoryUrl !== "string" ||
      record.repositoryUrl.trim() === ""
    ) {
      throw new TypeError("record.repositoryUrl must be a non-empty string");
    }
    if (typeof record.hasFailed !== "boolean") {
      throw new TypeError("record.hasFailed must be a boolean");
    }
  }
}
