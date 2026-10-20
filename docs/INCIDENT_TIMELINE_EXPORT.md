# Incident Timeline Export for Failed Scans

## Overview

Issue #1265 adds structured incident timeline tracking and multi-format exports for failed and aborted scans across GasGuard's repository analysis platform.

When a repository scan fails (due to AST parser crash, out-of-memory error, execution timeout, worker lease expiration, or security violation), platform operators and security engineers require a deterministic post-mortem timeline showing exactly when each phase started, which worker handled the job, lease fencing tokens, and sanitized diagnostic errors.

## Tenant Isolation & Concurrency Safety

- **Tenant Boundary**: Every incident event and exported record is strictly partitioned by `tenantId`. A tenant cannot discover, read, or export another tenant's incident timeline.
- **Concurrent Worker Ingestion**: Events emitted by different workers before or after incident finalization are safely merged and deterministically ordered by timestamp.
- **Idempotency**: Retried or duplicated finalization calls from supervisors preserve existing chronological event history without duplicating records.
- **Bounded Resource Consumption**: In-memory stores enforce `maxIncidentsPerTenant` (LRU eviction of oldest incidents) and `maxEventsPerIncident` (sliding truncation of excess events).

## Export Formats

The `IncidentTimelineExportService` supports three export formats:

### 1. JSON (`exportIncident(tenantId, scanId, "json")`)
Machine-readable canonical export conforming to platform observability schema. Includes worker lifecycle metadata, fencing tokens, diagnostics counts, and full error details.

### 2. Markdown (`exportIncident(tenantId, scanId, "markdown")`)
A comprehensive incident post-mortem markdown report complete with:
- Executive summary & metadata
- Worker lifecycle & lease fencing token
- AST parser diagnostics summary (recovered vs unrecovered)
- Chronological timeline markdown table
- Error details block with code, category, retryability, and stack excerpt

### 3. CSV (`exportIncident(tenantId, scanId, "csv")`)
RFC 4180 compliant CSV table suitable for spreadsheet and SIEM ingestion with headers:
`event_id,timestamp_iso,stage,severity,type,actor,message,error_code,retryable`

## Data Sanitization

All text fields, error messages, and repository URLs are sanitized using `sanitizeIncidentText` to strip:
- Ethereum/EVM 32-byte hexadecimal private keys (`0x[a-fA-F0-9]{64}`)
- Bearer / JWT authorization headers
- API keys, credentials, and tokens in URLs and message bodies

## Usage Example

```typescript
import { IncidentTimelineExportService, IncidentTimelineStore } from "./exports/incident-timeline";

const store = new IncidentTimelineStore();
const exportService = new IncidentTimelineExportService(store);

// Worker emits lifecycle events
store.recordEvent({
  eventId: "evt-01",
  scanId: "scan-1234",
  tenantId: "tenant-acme",
  timestamp: Date.now(),
  stage: "parsing",
  severity: "error",
  type: "parser_error",
  actor: "ast-worker-1",
  message: "AST syntax error encountered in Vault.sol",
  errorDetails: {
    code: "SYNTAX_ERROR",
    category: "fatal",
    message: "Unexpected token at line 42",
    retryable: false,
  },
});

// Finalize incident upon scan failure
exportService.finalizeIncident({
  incidentId: "inc-1234",
  scanId: "scan-1234",
  tenantId: "tenant-acme",
  repositoryUrl: "https://github.com/acme/defi-vaults",
  commitHash: "e5f2a1b",
  failureCategory: "PARSER_FAILURE",
  summary: "Solidity parser encountered unrecoverable syntax error in Vault.sol",
  startedAt: Date.now() - 3000,
  failedAt: Date.now(),
  durationMs: 3000,
  status: "failed",
  events: [],
});

// Export incident report as Markdown
const mdReport = exportService.exportIncident("tenant-acme", "scan-1234", "markdown");
console.log(mdReport.data);
```
