import {
  IncidentTimelineStore,
  sanitizeIncidentText,
} from "./incident-timeline-store";
import { IncidentTimelineExportService } from "./incident-timeline-export.service";
import { ScanIncidentRecord, TimelineEvent } from "./incident-timeline-types";

describe("Incident Timeline Export (#1265)", () => {
  describe("sanitizeIncidentText", () => {
    it("redacts private keys from incident descriptions and error messages", () => {
      const input =
        "Deployer failed using key 0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d for gas settlement";
      const sanitized = sanitizeIncidentText(input);
      expect(sanitized).toBe(
        "Deployer failed using key 0x[REDACTED_PRIVATE_KEY] for gas settlement",
      );
      expect(sanitized).not.toContain("4f3edf983ac");
    });

    it("redacts bearer tokens and secrets", () => {
      const input =
        "Authorization failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDN context token=secret_token_123";
      const sanitized = sanitizeIncidentText(input);
      expect(sanitized).toContain("Bearer [REDACTED_TOKEN]");
      expect(sanitized).toContain("token=[REDACTED]");
      expect(sanitized).not.toContain("secret_token_123");
    });
  });

  describe("IncidentTimelineStore - Tenant Isolation & Bounded Memory", () => {
    it("strictly isolates incidents between tenants", () => {
      const store = new IncidentTimelineStore();
      const incidentTenantA: ScanIncidentRecord = {
        incidentId: "inc-1",
        scanId: "scan-100",
        tenantId: "tenant-alpha",
        repositoryUrl: "https://github.com/org/repo-a",
        commitHash: "abc1234",
        failureCategory: "PARSER_FAILURE",
        summary: "Syntax error on contract parse",
        startedAt: 1000,
        failedAt: 2000,
        durationMs: 1000,
        status: "failed",
        events: [],
      };

      store.finalizeIncident(incidentTenantA);

      // Tenant Alpha can see scan-100
      expect(store.getIncident("tenant-alpha", "scan-100")).toBeDefined();

      // Tenant Beta cannot see scan-100
      expect(store.getIncident("tenant-beta", "scan-100")).toBeUndefined();
      expect(store.listIncidents("tenant-beta")).toHaveLength(0);
    });

    it("buffers events recorded before incident finalization and merges them", () => {
      const store = new IncidentTimelineStore();

      // Record events before incident is finalized
      store.recordEvent({
        eventId: "evt-1",
        scanId: "scan-200",
        tenantId: "tenant-alpha",
        timestamp: 1000,
        stage: "discovery",
        severity: "info",
        type: "scan_created",
        actor: "api",
        message: "Scan created",
      });

      store.recordEvent({
        eventId: "evt-2",
        scanId: "scan-200",
        tenantId: "tenant-alpha",
        timestamp: 1200,
        stage: "parsing",
        severity: "error",
        type: "parser_error",
        actor: "ast-worker",
        message:
          "Failed parsing Solidity AST with key 0x1111111111111111111111111111111111111111111111111111111111111111",
        errorDetails: {
          code: "SYNTAX_ERR",
          category: "fatal",
          message: "Unexpected identifier token=foo_secret",
          retryable: false,
        },
      });

      // Finalize
      const finalized = store.finalizeIncident({
        incidentId: "inc-200",
        scanId: "scan-200",
        tenantId: "tenant-alpha",
        repositoryUrl: "https://github.com/org/repo-b",
        commitHash: "def5678",
        failureCategory: "PARSER_FAILURE",
        summary: "AST parser failure",
        startedAt: 900,
        failedAt: 1300,
        durationMs: 400,
        status: "failed",
        events: [],
      });

      expect(finalized.events).toHaveLength(2);
      expect(finalized.events[0].eventId).toBe("evt-1");
      expect(finalized.events[1].eventId).toBe("evt-2");
      expect(finalized.events[1].message).toContain("0x[REDACTED_PRIVATE_KEY]");
      expect(finalized.events[1].errorDetails?.message).toContain(
        "token=[REDACTED]",
      );
    });

    it("bounds maximum incidents per tenant by evicting oldest", () => {
      const store = new IncidentTimelineStore({ maxIncidentsPerTenant: 2 });

      store.finalizeIncident({
        incidentId: "inc-1",
        scanId: "scan-1",
        tenantId: "tenant-a",
        repositoryUrl: "repo",
        commitHash: "c1",
        failureCategory: "TIMEOUT",
        summary: "Timeout 1",
        startedAt: 1,
        failedAt: 2,
        durationMs: 1,
        status: "failed",
        events: [],
      });

      store.finalizeIncident({
        incidentId: "inc-2",
        scanId: "scan-2",
        tenantId: "tenant-a",
        repositoryUrl: "repo",
        commitHash: "c2",
        failureCategory: "TIMEOUT",
        summary: "Timeout 2",
        startedAt: 3,
        failedAt: 4,
        durationMs: 1,
        status: "failed",
        events: [],
      });

      expect(store.listIncidents("tenant-a")).toHaveLength(2);

      // Add a third -> oldest (scan-1) should be evicted
      store.finalizeIncident({
        incidentId: "inc-3",
        scanId: "scan-3",
        tenantId: "tenant-a",
        repositoryUrl: "repo",
        commitHash: "c3",
        failureCategory: "TIMEOUT",
        summary: "Timeout 3",
        startedAt: 5,
        failedAt: 6,
        durationMs: 1,
        status: "failed",
        events: [],
      });

      const list = store.listIncidents("tenant-a");
      expect(list).toHaveLength(2);
      expect(store.getIncident("tenant-a", "scan-1")).toBeUndefined();
      expect(store.getIncident("tenant-a", "scan-2")).toBeDefined();
      expect(store.getIncident("tenant-a", "scan-3")).toBeDefined();
    });

    it("validates input arguments", () => {
      const store = new IncidentTimelineStore();
      expect(() => store.getIncident("", "scan-1")).toThrow(TypeError);
      expect(() => store.getIncident("tenant-a", "")).toThrow(TypeError);
      expect(() => store.listIncidents("")).toThrow(TypeError);
    });
  });

  describe("IncidentTimelineExportService - Formats", () => {
    let service: IncidentTimelineExportService;
    let sampleIncident: ScanIncidentRecord;

    beforeEach(() => {
      service = new IncidentTimelineExportService();
      sampleIncident = {
        incidentId: "inc-999",
        scanId: "scan-999",
        tenantId: "tenant-prod",
        repositoryUrl: "https://github.com/MDTechLabs/GasGuard",
        commitHash: "abc987654321",
        failureCategory: "RESOURCE_EXHAUSTION",
        summary: "Worker exceeded memory limit during AST generation",
        startedAt: 1697620000000,
        failedAt: 1697620045000,
        durationMs: 45000,
        status: "failed",
        workerLifecycle: {
          workerId: "worker-pool-node-3",
          leaseFencingToken: 42,
          leaseAcquiredAt: 1697620001000,
        },
        diagnosticsCount: {
          recovered: 4,
          unrecovered: 1,
          total: 5,
        },
        events: [
          {
            eventId: "evt-01",
            scanId: "scan-999",
            tenantId: "tenant-prod",
            timestamp: 1697620001000,
            stage: "discovery",
            severity: "info",
            type: "scan_created",
            actor: "api",
            message: "Scan job initialized",
          },
          {
            eventId: "evt-02",
            scanId: "scan-999",
            tenantId: "tenant-prod",
            timestamp: 1697620010000,
            stage: "parsing",
            severity: "warn",
            type: "parser_warning",
            actor: "ast-worker",
            message: "Deep AST recursion detected",
          },
          {
            eventId: "evt-03",
            scanId: "scan-999",
            tenantId: "tenant-prod",
            timestamp: 1697620045000,
            stage: "parsing",
            severity: "critical",
            type: "resource_limit_exceeded",
            actor: "worker-pool-node-3",
            message: "OOM killer invoked on child process",
            errorDetails: {
              code: "ERR_WORKER_OOM",
              category: "resource_limit",
              message: "Heap allocation out of memory",
              retryable: false,
              stackExcerpt: "Error: Heap limit exceeded at Parser.parse",
            },
          },
        ],
      };
      service.finalizeIncident(sampleIncident);
    });

    it("exports incident as JSON format", () => {
      const result = service.exportIncident("tenant-prod", "scan-999", "json");
      expect(result.format).toBe("json");
      expect(result.contentType).toBe("application/json");
      expect(result.filename).toBe("incident-scan-999-timeline.json");

      const parsed = JSON.parse(result.data);
      expect(parsed.incidentId).toBe("inc-999");
      expect(parsed.scanId).toBe("scan-999");
      expect(parsed.failureCategory).toBe("RESOURCE_EXHAUSTION");
      expect(parsed.workerLifecycle.workerId).toBe("worker-pool-node-3");
      expect(parsed.timelineEvents).toHaveLength(3);
      expect(parsed.timelineEvents[2].errorDetails.code).toBe("ERR_WORKER_OOM");
    });

    it("exports incident as Markdown format with full post-mortem sections", () => {
      const result = service.exportIncident(
        "tenant-prod",
        "scan-999",
        "markdown",
      );
      expect(result.format).toBe("markdown");
      expect(result.contentType).toBe("text/markdown");
      expect(result.filename).toBe("incident-scan-999-timeline.md");

      expect(result.data).toContain("# Incident Report: Scan scan-999");
      expect(result.data).toContain("RESOURCE_EXHAUSTION");
      expect(result.data).toContain("worker-pool-node-3");
      expect(result.data).toContain("Lease Fencing Token");
      expect(result.data).toContain("Diagnostics Summary");
      expect(result.data).toContain(
        "| Timestamp (UTC) | Stage | Severity | Event Type | Actor | Message |",
      );
      expect(result.data).toContain("OOM killer invoked on child process");
      expect(result.data).toContain("ERR_WORKER_OOM");
    });

    it("exports incident as RFC 4180 CSV format", () => {
      const result = service.exportIncident("tenant-prod", "scan-999", "csv");
      expect(result.format).toBe("csv");
      expect(result.contentType).toBe("text/csv");
      expect(result.filename).toBe("incident-scan-999-timeline.csv");

      const lines = result.data.split("\r\n");
      expect(lines[0]).toBe(
        "event_id,timestamp_iso,stage,severity,type,actor,message,error_code,retryable",
      );
      expect(lines).toHaveLength(4); // header + 3 events
      expect(lines[1]).toContain("evt-01");
      expect(lines[3]).toContain("ERR_WORKER_OOM");
    });

    it("throws when exporting non-existent incident or wrong tenant", () => {
      expect(() =>
        service.exportIncident("other-tenant", "scan-999", "json"),
      ).toThrow(/not found under tenant other-tenant/);
      expect(() =>
        service.exportIncident("tenant-prod", "non-existent-scan", "json"),
      ).toThrow(/not found under tenant tenant-prod/);
    });
  });
});
