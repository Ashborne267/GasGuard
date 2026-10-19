import { IncidentTimelineStore } from "./incident-timeline-store";
import { IncidentTimelineExportService } from "./incident-timeline-export.service";
import { ScanIncidentRecord, TimelineEvent } from "./incident-timeline-types";

describe("Incident Timeline Concurrency & Fault Integration (#1265)", () => {
  it("handles high concurrency from multiple workers emitting events for multiple scans", async () => {
    const service = new IncidentTimelineExportService();
    const store = service.getStore();
    const tenantCount = 3;
    const scansPerTenant = 5;
    const eventsPerScan = 20;

    const eventPromises: Promise<TimelineEvent>[] = [];

    for (let t = 0; t < tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      for (let s = 0; s < scansPerTenant; s++) {
        const scanId = `scan-${t}-${s}`;
        for (let e = 0; e < eventsPerScan; e++) {
          const promise = (async () => {
            return store.recordEvent({
              eventId: `evt-${t}-${s}-${e}`,
              scanId,
              tenantId,
              timestamp: Date.now() + e * 10,
              type: e === eventsPerScan - 1 ? "scan_failed" : "stage_started",
              severity: e === eventsPerScan - 1 ? "critical" : "info",
              stage: e < 10 ? "parsing" : "analyzing",
              actor: `worker-${(e % 4) + 1}`,
              message: `Progress step ${e} executed`,
            });
          })();
          eventPromises.push(promise);
        }
      }
    }

    await Promise.all(eventPromises);

    // Now finalize all scans concurrently
    const finalizePromises: Promise<ScanIncidentRecord>[] = [];
    for (let t = 0; t < tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      for (let s = 0; s < scansPerTenant; s++) {
        const scanId = `scan-${t}-${s}`;
        const p = (async () => {
          return service.finalizeIncident({
            incidentId: `inc-${t}-${s}`,
            scanId,
            tenantId,
            repositoryUrl: `https://github.com/org/repo-${s}`,
            commitHash: `commit-${s}`,
            failureCategory: "TIMEOUT",
            summary: "Concurrent scan test failed due to simulated timeout",
            startedAt: Date.now() - 5000,
            failedAt: Date.now(),
            durationMs: 5000,
            status: "failed",
            events: [],
          });
        })();
        finalizePromises.push(p);
      }
    }

    await Promise.all(finalizePromises);

    // Verify each tenant has exactly scansPerTenant incidents
    for (let t = 0; t < tenantCount; t++) {
      const tenantId = `tenant-${t}`;
      const list = service.listIncidents(tenantId);
      expect(list).toHaveLength(scansPerTenant);

      for (let s = 0; s < scansPerTenant; s++) {
        const scanId = `scan-${t}-${s}`;
        const incident = service.getIncident(tenantId, scanId);
        expect(incident).toBeDefined();
        expect(incident!.events).toHaveLength(eventsPerScan);
        // Verify chronological monotonicity
        for (let i = 1; i < incident!.events.length; i++) {
          expect(incident!.events[i].timestamp).toBeGreaterThanOrEqual(
            incident!.events[i - 1].timestamp,
          );
        }

        // Test export succeeds
        const jsonExport = service.exportIncident(tenantId, scanId, "json");
        expect(jsonExport.metadata.eventCount).toBe(eventsPerScan);
      }
    }
  });

  it("recovers after interruption and duplicate finalize calls (idempotency)", () => {
    const service = new IncidentTimelineExportService();
    const tenantId = "tenant-recovery";
    const scanId = "scan-recovered";

    service.recordEvent({
      eventId: "e-1",
      scanId,
      tenantId,
      timestamp: 100,
      stage: "discovery",
      severity: "info",
      type: "scan_created",
      actor: "api",
      message: "Started",
    });

    const incident: ScanIncidentRecord = {
      incidentId: "inc-rec-1",
      scanId,
      tenantId,
      repositoryUrl: "https://github.com/test/repo",
      commitHash: "hash123",
      failureCategory: "LEASE_EXPIRED",
      summary: "Worker crashed and lease expired",
      startedAt: 100,
      failedAt: 500,
      durationMs: 400,
      status: "failed",
      events: [],
    };

    // First worker finalizes
    service.finalizeIncident(incident);
    // Duplicate call from retrying supervisor/worker
    service.finalizeIncident(incident);

    const saved = service.getIncident(tenantId, scanId);
    expect(saved).toBeDefined();
    expect(saved!.events).toHaveLength(1);
  });
});
