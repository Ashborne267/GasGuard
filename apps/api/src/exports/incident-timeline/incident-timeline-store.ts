import {
  DEFAULT_INCIDENT_STORE_CONFIG,
  FailureCategory,
  IncidentTimelineStoreConfig,
  ScanIncidentRecord,
  TimelineEvent,
} from "./incident-timeline-types";

/**
 * Sanitizes arbitrary text to strip secrets, API keys, private keys, and passwords.
 */
export function sanitizeIncidentText(input: string): string {
  if (!input || typeof input !== "string") {
    return "";
  }
  return (
    input
      // Hex private keys (0x followed by 64 hex characters)
      .replace(/0x[a-fA-F0-9]{64}/g, "0x[REDACTED_PRIVATE_KEY]")
      // Bearer / JWT tokens
      .replace(
        /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g,
        "Bearer [REDACTED_TOKEN]",
      )
      // Generic tokens/passwords/secrets
      .replace(
        /(password|secret|token|api_?key|auth)["']?\s*[:=]\s*["']?([^"',;\s]+)/gi,
        "$1=[REDACTED]",
      )
      // URL embedded credentials
      .replace(/:\/\/([^:]+):([^@]+)@/g, "://$1:[REDACTED]@")
  );
}

export class IncidentTimelineStore {
  private readonly config: IncidentTimelineStoreConfig;
  // Map<tenantId, Map<scanId, ScanIncidentRecord>>
  private readonly tenantIncidents: Map<
    string,
    Map<string, ScanIncidentRecord>
  > = new Map();
  // Buffer for events arriving before an incident record is finalized: Map<tenantId, Map<scanId, TimelineEvent[]>>
  private readonly pendingEvents: Map<string, Map<string, TimelineEvent[]>> =
    new Map();

  constructor(config?: Partial<IncidentTimelineStoreConfig>) {
    this.config = { ...DEFAULT_INCIDENT_STORE_CONFIG, ...config };
    if (this.config.maxIncidentsPerTenant <= 0) {
      throw new RangeError("maxIncidentsPerTenant must be a positive integer");
    }
    if (this.config.maxEventsPerIncident <= 0) {
      throw new RangeError("maxEventsPerIncident must be a positive integer");
    }
  }

  /**
   * Records a timeline event for a scan. Preserves strict tenant isolation.
   */
  recordEvent(event: TimelineEvent): TimelineEvent {
    this.validateTenantAndScan(event.tenantId, event.scanId);

    const sanitizedMessage = sanitizeIncidentText(event.message);
    const sanitizedError = event.errorDetails
      ? {
          ...event.errorDetails,
          message: sanitizeIncidentText(event.errorDetails.message),
          stackExcerpt: event.errorDetails.stackExcerpt
            ? sanitizeIncidentText(event.errorDetails.stackExcerpt)
            : undefined,
        }
      : undefined;

    const sanitizedEvent: TimelineEvent = {
      ...event,
      message: sanitizedMessage,
      errorDetails: sanitizedError,
    };

    const tenantMap = this.getOrCreateTenantIncidents(event.tenantId);
    const existingIncident = tenantMap.get(event.scanId);

    if (existingIncident) {
      this.addEventToIncident(existingIncident, sanitizedEvent);
    } else {
      // Buffer event in pending events map until incident is finalized
      let tenantPending = this.pendingEvents.get(event.tenantId);
      if (!tenantPending) {
        tenantPending = new Map();
        this.pendingEvents.set(event.tenantId, tenantPending);
      }
      let scanEvents = tenantPending.get(event.scanId);
      if (!scanEvents) {
        scanEvents = [];
        tenantPending.set(event.scanId, scanEvents);
      }
      if (scanEvents.length < this.config.maxEventsPerIncident) {
        scanEvents.push(sanitizedEvent);
        scanEvents.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    return sanitizedEvent;
  }

  /**
   * Finalizes an incident record when a scan fails or aborts.
   * Merges any buffered events for this scan.
   */
  finalizeIncident(incident: ScanIncidentRecord): ScanIncidentRecord {
    this.validateTenantAndScan(incident.tenantId, incident.scanId);

    const tenantMap = this.getOrCreateTenantIncidents(incident.tenantId);

    // Bounded eviction per tenant
    if (
      !tenantMap.has(incident.scanId) &&
      tenantMap.size >= this.config.maxIncidentsPerTenant
    ) {
      const oldestScanId = tenantMap.keys().next().value;
      if (oldestScanId) {
        tenantMap.delete(oldestScanId);
      }
    }

    const tenantPending = this.pendingEvents.get(incident.tenantId);
    const pending = tenantPending?.get(incident.scanId) ?? [];
    if (tenantPending) {
      tenantPending.delete(incident.scanId);
    }

    const existingEvents = tenantMap.get(incident.scanId)?.events ?? [];
    const allEvents = [...existingEvents, ...pending, ...incident.events];
    // Deduplicate and sort chronologically
    const uniqueEvents = Array.from(
      new Map(allEvents.map((e) => [e.eventId, e])).values(),
    ).sort((a, b) => a.timestamp - b.timestamp);

    const boundedEvents = uniqueEvents.slice(
      0,
      this.config.maxEventsPerIncident,
    );

    const sanitizedIncident: ScanIncidentRecord = {
      ...incident,
      repositoryUrl: sanitizeIncidentText(incident.repositoryUrl),
      summary: sanitizeIncidentText(incident.summary),
      events: boundedEvents,
    };

    tenantMap.set(incident.scanId, sanitizedIncident);
    return sanitizedIncident;
  }

  /**
   * Retrieves an incident by scan ID, enforcing tenant isolation.
   */
  getIncident(
    tenantId: string,
    scanId: string,
  ): ScanIncidentRecord | undefined {
    this.validateTenantAndScan(tenantId, scanId);
    const tenantMap = this.tenantIncidents.get(tenantId);
    return tenantMap?.get(scanId);
  }

  /**
   * Lists all incidents for a specific tenant with optional pagination.
   */
  listIncidents(
    tenantId: string,
    options?: { limit?: number; offset?: number },
  ): ScanIncidentRecord[] {
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new TypeError("tenantId must be a non-empty string");
    }

    const tenantMap = this.tenantIncidents.get(tenantId);
    if (!tenantMap) {
      return [];
    }

    const list = Array.from(tenantMap.values()).reverse(); // most recent first
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(1, options?.limit ?? 50);

    return list.slice(offset, offset + limit);
  }

  /**
   * Deletes an incident record for a tenant.
   */
  deleteIncident(tenantId: string, scanId: string): boolean {
    this.validateTenantAndScan(tenantId, scanId);
    const tenantMap = this.tenantIncidents.get(tenantId);
    return tenantMap?.delete(scanId) ?? false;
  }

  clearTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== "string") {
      throw new TypeError("tenantId must be a non-empty string");
    }
    this.tenantIncidents.delete(tenantId);
    this.pendingEvents.delete(tenantId);
  }

  clearAll(): void {
    this.tenantIncidents.clear();
    this.pendingEvents.clear();
  }

  private addEventToIncident(
    incident: ScanIncidentRecord,
    event: TimelineEvent,
  ): void {
    if (incident.events.some((e) => e.eventId === event.eventId)) {
      return;
    }
    if (incident.events.length < this.config.maxEventsPerIncident) {
      incident.events.push(event);
      incident.events.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  private getOrCreateTenantIncidents(
    tenantId: string,
  ): Map<string, ScanIncidentRecord> {
    let tenantMap = this.tenantIncidents.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.tenantIncidents.set(tenantId, tenantMap);
    }
    return tenantMap;
  }

  private validateTenantAndScan(tenantId: string, scanId: string): void {
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new TypeError("tenantId must be a non-empty string");
    }
    if (!scanId || typeof scanId !== "string" || scanId.trim() === "") {
      throw new TypeError("scanId must be a non-empty string");
    }
  }
}
