import {
  ExportFormat,
  IncidentExportResult,
  ScanIncidentRecord,
  TimelineEvent,
} from "./incident-timeline-types";
import { IncidentTimelineStore } from "./incident-timeline-store";

export class IncidentTimelineExportService {
  constructor(
    private readonly store: IncidentTimelineStore = new IncidentTimelineStore(),
  ) {}

  getStore(): IncidentTimelineStore {
    return this.store;
  }

  recordEvent(event: TimelineEvent): TimelineEvent {
    return this.store.recordEvent(event);
  }

  finalizeIncident(incident: ScanIncidentRecord): ScanIncidentRecord {
    return this.store.finalizeIncident(incident);
  }

  getIncident(
    tenantId: string,
    scanId: string,
  ): ScanIncidentRecord | undefined {
    return this.store.getIncident(tenantId, scanId);
  }

  listIncidents(
    tenantId: string,
    options?: { limit?: number; offset?: number },
  ): ScanIncidentRecord[] {
    return this.store.listIncidents(tenantId, options);
  }

  exportIncident(
    tenantId: string,
    scanId: string,
    format: ExportFormat,
  ): IncidentExportResult {
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new TypeError("tenantId must be a non-empty string");
    }
    if (!scanId || typeof scanId !== "string" || scanId.trim() === "") {
      throw new TypeError("scanId must be a non-empty string");
    }

    const incident = this.store.getIncident(tenantId, scanId);
    if (!incident) {
      throw new Error(
        `Incident for scan ${scanId} not found under tenant ${tenantId}`,
      );
    }

    const nowIso = new Date().toISOString();
    let data: string;
    let contentType: string;
    let extension: string;

    switch (format) {
      case "json":
        data = this.formatJson(incident);
        contentType = "application/json";
        extension = "json";
        break;
      case "markdown":
        data = this.formatMarkdown(incident);
        contentType = "text/markdown";
        extension = "md";
        break;
      case "csv":
        data = this.formatCsv(incident);
        contentType = "text/csv";
        extension = "csv";
        break;
      default:
        throw new TypeError(`Unsupported export format: ${format}`);
    }

    const filename = `incident-${incident.scanId}-timeline.${extension}`;

    return {
      format,
      contentType,
      filename,
      data,
      metadata: {
        scanId: incident.scanId,
        incidentId: incident.incidentId,
        tenantId: incident.tenantId,
        eventCount: incident.events.length,
        generatedAt: nowIso,
      },
    };
  }

  formatJson(incident: ScanIncidentRecord): string {
    return JSON.stringify(
      {
        incidentId: incident.incidentId,
        scanId: incident.scanId,
        tenantId: incident.tenantId,
        status: incident.status,
        failureCategory: incident.failureCategory,
        summary: incident.summary,
        repositoryUrl: incident.repositoryUrl,
        commitHash: incident.commitHash,
        startedAt: new Date(incident.startedAt).toISOString(),
        failedAt: new Date(incident.failedAt).toISOString(),
        durationMs: incident.durationMs,
        workerLifecycle: incident.workerLifecycle,
        diagnosticsCount: incident.diagnosticsCount,
        timelineEvents: incident.events.map((e) => ({
          eventId: e.eventId,
          timestamp: new Date(e.timestamp).toISOString(),
          stage: e.stage,
          severity: e.severity,
          type: e.type,
          actor: e.actor,
          message: e.message,
          metadata: e.metadata,
          errorDetails: e.errorDetails,
        })),
      },
      null,
      2,
    );
  }

  formatMarkdown(incident: ScanIncidentRecord): string {
    const lines: string[] = [];

    lines.push(`# Incident Report: Scan ${incident.scanId}`);
    lines.push("");
    lines.push(`- **Incident ID:** \`${incident.incidentId}\``);
    lines.push(`- **Tenant ID:** \`${incident.tenantId}\``);
    lines.push(`- **Status:** \`${incident.status.toUpperCase()}\``);
    lines.push(`- **Failure Category:** \`${incident.failureCategory}\``);
    lines.push(`- **Repository:** ${incident.repositoryUrl}`);
    lines.push(`- **Commit:** \`${incident.commitHash}\``);
    lines.push(`- **Duration:** ${incident.durationMs}ms`);
    lines.push(
      `- **Failure Time:** ${new Date(incident.failedAt).toISOString()}`,
    );

    if (incident.workerLifecycle) {
      lines.push("");
      lines.push("## Worker Lifecycle");
      lines.push(`- **Worker ID:** \`${incident.workerLifecycle.workerId}\``);
      if (incident.workerLifecycle.leaseFencingToken !== undefined) {
        lines.push(
          `- **Lease Fencing Token:** \`${incident.workerLifecycle.leaseFencingToken}\``,
        );
      }
      if (incident.workerLifecycle.leaseAcquiredAt) {
        lines.push(
          `- **Lease Acquired At:** ${new Date(incident.workerLifecycle.leaseAcquiredAt).toISOString()}`,
        );
      }
    }

    if (incident.diagnosticsCount) {
      lines.push("");
      lines.push("## Diagnostics Summary");
      lines.push(`- **Total Diagnostics:** ${incident.diagnosticsCount.total}`);
      lines.push(
        `- **Recovered Warnings:** ${incident.diagnosticsCount.recovered}`,
      );
      lines.push(
        `- **Unrecovered Errors:** ${incident.diagnosticsCount.unrecovered}`,
      );
    }

    lines.push("");
    lines.push("## Summary & Root Cause");
    lines.push(incident.summary);

    lines.push("");
    lines.push("## Chronological Timeline");
    lines.push(
      "| Timestamp (UTC) | Stage | Severity | Event Type | Actor | Message |",
    );
    lines.push("|---|---|---|---|---|---|");

    for (const event of incident.events) {
      const timeStr = new Date(event.timestamp).toISOString();
      const cleanMsg = event.message.replace(/\|/g, "\\|");
      lines.push(
        `| ${timeStr} | ${event.stage} | ${event.severity.toUpperCase()} | ${event.type} | ${event.actor} | ${cleanMsg} |`,
      );
    }

    const errorsWithDetails = incident.events.filter((e) => e.errorDetails);
    if (errorsWithDetails.length > 0) {
      lines.push("");
      lines.push("## Error Details");
      for (const errEvent of errorsWithDetails) {
        lines.push(
          `### [${errEvent.errorDetails!.code}] ${errEvent.errorDetails!.message}`,
        );
        lines.push(`- **Category:** ${errEvent.errorDetails!.category}`);
        lines.push(
          `- **Retryable:** ${errEvent.errorDetails!.retryable ? "Yes" : "No"}`,
        );
        if (errEvent.errorDetails!.stackExcerpt) {
          lines.push("```");
          lines.push(errEvent.errorDetails!.stackExcerpt);
          lines.push("```");
        }
      }
    }

    return lines.join("\n");
  }

  formatCsv(incident: ScanIncidentRecord): string {
    const headers = [
      "event_id",
      "timestamp_iso",
      "stage",
      "severity",
      "type",
      "actor",
      "message",
      "error_code",
      "retryable",
    ];

    const rows = incident.events.map((e) => [
      escapeCsv(e.eventId),
      escapeCsv(new Date(e.timestamp).toISOString()),
      escapeCsv(e.stage),
      escapeCsv(e.severity),
      escapeCsv(e.type),
      escapeCsv(e.actor),
      escapeCsv(e.message),
      escapeCsv(e.errorDetails?.code ?? ""),
      escapeCsv(
        e.errorDetails ? (e.errorDetails.retryable ? "true" : "false") : "",
      ),
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  }
}

function escapeCsv(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
