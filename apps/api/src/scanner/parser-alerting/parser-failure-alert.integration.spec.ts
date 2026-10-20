import * as fs from "fs";
import * as path from "path";
import { ParserFailureAlertService } from "./parser-failure-alert.service";
import { ParserAlert } from "./parser-failure-alert-types";

describe("Parser Failure Alerting Fixtures & Regression Integration (#1262)", () => {
  it("processes realistic repository scan fixture and matches regression snapshot deterministically", async () => {
    const fixturePath = path.join(
      __dirname,
      "__fixtures__",
      "repeated-parser-failures-repo.json",
    );
    const regressionPath = path.join(
      __dirname,
      "__fixtures__",
      "parser-alert-regression-snapshot.json",
    );

    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    const regressionSnapshot = JSON.parse(
      fs.readFileSync(regressionPath, "utf-8"),
    );

    const triggeredAlerts: ParserAlert[] = [];
    const resolvedAlerts: ParserAlert[] = [];

    let mockClock = 1700000000000;
    const service = new ParserFailureAlertService(
      {
        consecutiveFailuresThreshold: 3,
        autoResolveConsecutiveSuccesses: 2,
        cooldownPeriodMs: 60000,
      },
      () => mockClock,
    );

    service.registerHandler({
      onAlert: (alert) => {
        if (alert.status === "active") {
          triggeredAlerts.push(alert);
        } else if (alert.status === "resolved") {
          resolvedAlerts.push(alert);
        }
      },
    });

    const tenantId = "tenant-defi-vault";

    for (const scan of fixtureData.scans) {
      mockClock += 10000;
      await service.recordScan({
        scanId: scan.scanId,
        tenantId,
        repositoryUrl: fixtureData.repository.url,
        commitHash: scan.commitHash,
        language: scan.language,
        parserName: scan.parserName,
        timestamp: mockClock,
        hasFailed: scan.hasFailed,
        failureCategory: scan.failureCategory,
        diagnosticCodes: scan.diagnosticCodes,
        errorSummary: scan.errorSummary,
      });
    }

    // Assert regression snapshot properties
    expect(triggeredAlerts).toHaveLength(
      regressionSnapshot.expectedAlertsTriggered,
    );
    expect(resolvedAlerts).toHaveLength(
      regressionSnapshot.expectedAlertsResolved,
    );

    const triggered = triggeredAlerts[0];
    expect(triggered.consecutiveFailures).toBe(
      regressionSnapshot.expectedConsecutiveFailuresAtTrigger,
    );
    expect(triggered.severity).toBe(
      regressionSnapshot.expectedSeverityAtTrigger,
    );
    expect(triggered.diagnosticCodesSummary).toEqual(
      regressionSnapshot.expectedDiagnosticCodes,
    );

    const resolved = resolvedAlerts[0];
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeDefined();

    const metrics = service.getMetrics();
    expect(metrics.totalScansEvaluated).toBe(fixtureData.scans.length);
    expect(metrics.activeAlertsCount).toBe(0);
    expect(metrics.totalAlertsDispatched).toBe(1);
    expect(metrics.totalAlertsResolved).toBe(1);
  });

  it("maintains determinism across repeated executions with identical inputs", async () => {
    const runSimulation = async () => {
      let time = 1000;
      const service = new ParserFailureAlertService(
        {
          consecutiveFailuresThreshold: 2,
          autoResolveConsecutiveSuccesses: 2,
        },
        () => time,
      );

      const records = [
        { scanId: "s1", fail: true, codes: ["err1"] },
        { scanId: "s2", fail: true, codes: ["err2"] },
        { scanId: "s3", fail: false, codes: [] },
        { scanId: "s4", fail: false, codes: [] },
      ];

      const events: string[] = [];
      service.registerHandler({
        onAlert: (a) => {
          events.push(
            `${a.status}:${a.consecutiveFailures}:${JSON.stringify(a.diagnosticCodesSummary)}`,
          );
        },
      });

      for (const r of records) {
        time += 100;
        await service.recordScan({
          scanId: r.scanId,
          tenantId: "tenant-det",
          repositoryUrl: "https://repo",
          commitHash: "hash",
          language: "solidity",
          parserName: "p1",
          timestamp: time,
          hasFailed: r.fail,
          diagnosticCodes: r.codes,
        });
      }

      return events;
    };

    const run1 = await runSimulation();
    const run2 = await runSimulation();

    expect(run1).toEqual(run2);
    expect(run1).toEqual([
      'active:2:{"err1":1,"err2":1}',
      'resolved:2:{"err1":1,"err2":1}',
    ]);
  });
});
