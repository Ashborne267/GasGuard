import {
  AlertNotificationHandler,
  ParserAlert,
  ParserAlertConfig,
  ParserAlertMetrics,
  ParserScanRecord,
} from "./parser-failure-alert-types";
import { ParserFailureAlertTracker } from "./parser-failure-alert-tracker";

export class ParserFailureAlertService {
  private readonly tracker: ParserFailureAlertTracker;
  private readonly handlers: AlertNotificationHandler[] = [];
  private totalScansEvaluated = 0;
  private totalFailuresRecorded = 0;
  private totalAlertsDispatched = 0;
  private totalAlertsResolved = 0;

  constructor(
    config?: Partial<ParserAlertConfig>,
    clock: () => number = Date.now,
  ) {
    this.tracker = new ParserFailureAlertTracker(config, clock);
  }

  getTracker(): ParserFailureAlertTracker {
    return this.tracker;
  }

  registerHandler(handler: AlertNotificationHandler): void {
    if (!handler || typeof handler.onAlert !== "function") {
      throw new TypeError("handler must implement onAlert function");
    }
    this.handlers.push(handler);
  }

  async recordScan(record: ParserScanRecord): Promise<{
    alertTriggered?: ParserAlert;
    alertResolved?: ParserAlert;
    isSuppressed: boolean;
  }> {
    this.totalScansEvaluated += 1;
    if (record.hasFailed) {
      this.totalFailuresRecorded += 1;
    }

    const outcome = this.tracker.recordScan(record);

    if (outcome.alertTriggered && !outcome.isSuppressed) {
      this.totalAlertsDispatched += 1;
      await this.dispatchToHandlers(outcome.alertTriggered);
    }

    if (outcome.alertResolved) {
      this.totalAlertsResolved += 1;
      await this.dispatchToHandlers(outcome.alertResolved);
    }

    return outcome;
  }

  getActiveAlerts(tenantId?: string): ParserAlert[] {
    return this.tracker.getActiveAlerts(tenantId);
  }

  getAlertHistory(tenantId: string): ParserAlert[] {
    return this.tracker.getAlertHistory(tenantId);
  }

  getMetrics(): ParserAlertMetrics {
    return {
      totalScansEvaluated: this.totalScansEvaluated,
      totalFailuresRecorded: this.totalFailuresRecorded,
      activeAlertsCount: this.tracker.getActiveAlerts().length,
      totalAlertsDispatched: this.totalAlertsDispatched,
      totalAlertsResolved: this.totalAlertsResolved,
    };
  }

  clear(): void {
    this.tracker.clear();
    this.totalScansEvaluated = 0;
    this.totalFailuresRecorded = 0;
    this.totalAlertsDispatched = 0;
    this.totalAlertsResolved = 0;
  }

  private async dispatchToHandlers(alert: ParserAlert): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler.onAlert(alert);
      } catch (err) {
        // Defensive: sink failure must never throw to caller or stop other sinks
        console.error("[ParserAlertService] Handler dispatch error:", err);
      }
    }
  }
}
