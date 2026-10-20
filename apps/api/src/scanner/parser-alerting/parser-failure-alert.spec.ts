import {
  ParserFailureAlertTracker,
  resolveParserAlertConfig,
} from "./parser-failure-alert-tracker";
import { ParserFailureAlertService } from "./parser-failure-alert.service";
import { ParserAlert, ParserScanRecord } from "./parser-failure-alert-types";

describe("Repeated Parser Failure Alerting (#1262)", () => {
  describe("resolveParserAlertConfig", () => {
    it("returns defaults when no overrides provided", () => {
      const config = resolveParserAlertConfig();
      expect(config.consecutiveFailuresThreshold).toBe(3);
      expect(config.failureRatioThreshold).toBe(0.4);
      expect(config.windowSize).toBe(10);
      expect(config.cooldownPeriodMs).toBe(300_000);
      expect(config.autoResolveConsecutiveSuccesses).toBe(2);
    });

    it("rejects non-positive integers", () => {
      expect(() =>
        resolveParserAlertConfig({ consecutiveFailuresThreshold: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        resolveParserAlertConfig({ consecutiveFailuresThreshold: -2 }),
      ).toThrow(RangeError);
      expect(() => resolveParserAlertConfig({ windowSize: 0 })).toThrow(
        RangeError,
      );
    });

    it("rejects invalid failure ratio thresholds", () => {
      expect(() =>
        resolveParserAlertConfig({ failureRatioThreshold: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        resolveParserAlertConfig({ failureRatioThreshold: 1.5 }),
      ).toThrow(RangeError);
      expect(() =>
        resolveParserAlertConfig({ failureRatioThreshold: -0.1 }),
      ).toThrow(RangeError);
    });

    it("rejects minScansForRatio greater than windowSize", () => {
      expect(() =>
        resolveParserAlertConfig({ windowSize: 5, minScansForRatio: 10 }),
      ).toThrow(RangeError);
    });
  });

  describe("ParserFailureAlertTracker - Consecutive Failures", () => {
    let tracker: ParserFailureAlertTracker;
    let mockTime: number;

    beforeEach(() => {
      mockTime = 100000;
      tracker = new ParserFailureAlertTracker(
        {
          consecutiveFailuresThreshold: 3,
          cooldownPeriodMs: 60000,
          autoResolveConsecutiveSuccesses: 2,
        },
        () => mockTime,
      );
    });

    it("does not trigger alert before reaching consecutive failures threshold", () => {
      const record1: ParserScanRecord = {
        scanId: "s-1",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
        failureCategory: "syntax_error",
        diagnosticCodes: ["unexpected_token"],
      };

      const res1 = tracker.recordScan(record1);
      expect(res1.alertTriggered).toBeUndefined();
      expect(tracker.getActiveAlerts()).toHaveLength(0);

      const record2 = { ...record1, scanId: "s-2", commitHash: "c2" };
      const res2 = tracker.recordScan(record2);
      expect(res2.alertTriggered).toBeUndefined();
    });

    it("triggers alert on third consecutive failure with diagnostic code summary", () => {
      const base: ParserScanRecord = {
        scanId: "s-1",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
        failureCategory: "syntax_error",
        diagnosticCodes: ["unexpected_token"],
      };

      tracker.recordScan({ ...base, scanId: "s-1" });
      tracker.recordScan({
        ...base,
        scanId: "s-2",
        diagnosticCodes: ["recursion_limit"],
      });

      const res3 = tracker.recordScan({ ...base, scanId: "s-3" });
      expect(res3.alertTriggered).toBeDefined();
      expect(res3.isSuppressed).toBe(false);

      const alert = res3.alertTriggered!;
      expect(alert.status).toBe("active");
      expect(alert.severity).toBe("warning");
      expect(alert.consecutiveFailures).toBe(3);
      expect(alert.diagnosticCodesSummary).toEqual({
        unexpected_token: 2,
        recursion_limit: 1,
      });

      expect(tracker.getActiveAlerts("tenant-a")).toHaveLength(1);
    });

    it("suppresses repeated alert notifications while inside cooldown period", () => {
      const base: ParserScanRecord = {
        scanId: "s-1",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
      };

      tracker.recordScan({ ...base, scanId: "s-1" });
      tracker.recordScan({ ...base, scanId: "s-2" });
      const res3 = tracker.recordScan({ ...base, scanId: "s-3" });
      expect(res3.alertTriggered).toBeDefined();

      // Next failure arrives 10 seconds later (cooldown is 60s)
      mockTime += 10000;
      const res4 = tracker.recordScan({ ...base, scanId: "s-4" });
      expect(res4.isSuppressed).toBe(true);
      expect(res4.alertTriggered).toBeUndefined();

      // Active alert has updated notification count and consecutive failure count
      const active = tracker.getActiveAlerts("tenant-a")[0];
      expect(active.notificationCount).toBe(2);
      expect(active.consecutiveFailures).toBe(4);
    });

    it("re-dispatches alert after cooldown period expires and escalates severity", () => {
      const base: ParserScanRecord = {
        scanId: "s-1",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
      };

      tracker.recordScan({ ...base, scanId: "s-1" });
      tracker.recordScan({ ...base, scanId: "s-2" });
      tracker.recordScan({ ...base, scanId: "s-3" });

      // Jump 70 seconds ahead (cooldown is 60s), failure 4
      mockTime += 70000;
      tracker.recordScan({ ...base, scanId: "s-4" });
      tracker.recordScan({ ...base, scanId: "s-5" });

      // Jump another 70 seconds ahead, failure 6 (>= consecutiveFailuresThreshold * 2)
      mockTime += 70000;
      const res6 = tracker.recordScan({ ...base, scanId: "s-6" });
      expect(res6.isSuppressed).toBe(false);
      expect(res6.alertTriggered).toBeDefined();
      expect(res6.alertTriggered!.severity).toBe("critical");
    });

    it("automatically resolves alert after configured consecutive successes", () => {
      const base: ParserScanRecord = {
        scanId: "s-1",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
      };

      tracker.recordScan({ ...base, scanId: "s-1" });
      tracker.recordScan({ ...base, scanId: "s-2" });
      tracker.recordScan({ ...base, scanId: "s-3" });
      expect(tracker.getActiveAlerts("tenant-a")).toHaveLength(1);

      // 1st success -> not yet resolved (autoResolveConsecutiveSuccesses = 2)
      const resSuccess1 = tracker.recordScan({
        ...base,
        scanId: "s-4",
        hasFailed: false,
      });
      expect(resSuccess1.alertResolved).toBeUndefined();
      expect(tracker.getActiveAlerts("tenant-a")).toHaveLength(1);

      // 2nd success -> auto-resolves!
      const resSuccess2 = tracker.recordScan({
        ...base,
        scanId: "s-5",
        hasFailed: false,
      });
      expect(resSuccess2.alertResolved).toBeDefined();
      expect(resSuccess2.alertResolved!.status).toBe("resolved");
      expect(resSuccess2.alertResolved!.resolvedAt).toBe(mockTime);

      expect(tracker.getActiveAlerts("tenant-a")).toHaveLength(0);
      expect(tracker.getAlertHistory("tenant-a")).toHaveLength(1);
    });

    it("enforces strict tenant isolation across repositories and alerts", () => {
      const baseA: ParserScanRecord = {
        scanId: "s-a",
        tenantId: "tenant-a",
        repositoryUrl: "https://github.com/org/repo",
        commitHash: "c1",
        language: "solidity",
        parserName: "solidity-ast",
        timestamp: mockTime,
        hasFailed: true,
      };

      const baseB: ParserScanRecord = {
        ...baseA,
        scanId: "s-b",
        tenantId: "tenant-b",
      };

      // Tenant A fails 3 times -> alert
      tracker.recordScan({ ...baseA, scanId: "s-a1" });
      tracker.recordScan({ ...baseA, scanId: "s-a2" });
      tracker.recordScan({ ...baseA, scanId: "s-a3" });

      expect(tracker.getActiveAlerts("tenant-a")).toHaveLength(1);
      expect(tracker.getActiveAlerts("tenant-b")).toHaveLength(0);

      // Tenant B fails once -> no alert
      tracker.recordScan({ ...baseB, scanId: "s-b1" });
      expect(tracker.getActiveAlerts("tenant-b")).toHaveLength(0);
    });
  });

  describe("ParserFailureAlertService - Dispatching and Metrics", () => {
    it("dispatches notifications to registered handlers and computes metrics", async () => {
      const dispatchedAlerts: ParserAlert[] = [];
      const service = new ParserFailureAlertService({
        consecutiveFailuresThreshold: 2,
        autoResolveConsecutiveSuccesses: 1,
      });

      service.registerHandler({
        onAlert: (alert) => {
          dispatchedAlerts.push(alert);
        },
      });

      // Record 1 failure
      await service.recordScan({
        scanId: "sc-1",
        tenantId: "tenant-service-test",
        repositoryUrl: "https://github.com/org/defi",
        commitHash: "hash-1",
        language: "rust",
        parserName: "soroban-ast",
        timestamp: 100,
        hasFailed: true,
      });

      expect(dispatchedAlerts).toHaveLength(0);

      // Record 2nd failure -> alert dispatched
      await service.recordScan({
        scanId: "sc-2",
        tenantId: "tenant-service-test",
        repositoryUrl: "https://github.com/org/defi",
        commitHash: "hash-2",
        language: "rust",
        parserName: "soroban-ast",
        timestamp: 200,
        hasFailed: true,
      });

      expect(dispatchedAlerts).toHaveLength(1);
      expect(dispatchedAlerts[0].status).toBe("active");

      // Record success -> resolved alert dispatched
      await service.recordScan({
        scanId: "sc-3",
        tenantId: "tenant-service-test",
        repositoryUrl: "https://github.com/org/defi",
        commitHash: "hash-3",
        language: "rust",
        parserName: "soroban-ast",
        timestamp: 300,
        hasFailed: false,
      });

      expect(dispatchedAlerts).toHaveLength(2);
      expect(dispatchedAlerts[1].status).toBe("resolved");

      const metrics = service.getMetrics();
      expect(metrics.totalScansEvaluated).toBe(3);
      expect(metrics.totalFailuresRecorded).toBe(2);
      expect(metrics.totalAlertsDispatched).toBe(1);
      expect(metrics.totalAlertsResolved).toBe(1);
      expect(metrics.activeAlertsCount).toBe(0);
    });
  });
});
