# Distributed Trace Propagation Across API and Workers

## Overview

Issue #1263 implements distributed trace propagation compliant with the W3C Trace Context Level 1 standard across GasGuard's API gateway, message queues, and background analyzer workers.

By injecting and extracting trace identifiers (`traceparent`, `tracestate`, and `baggage`), distributed requests can be traced from incoming user/webhook requests through BullMQ queues into AST parsing workers and rule analyzers without losing causal linkages or tenant boundaries.

## W3C Trace Context Standard

Trace propagation strictly adheres to the W3C format:
```
traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}
```
- `version`: `00`
- `trace-id`: 32-character hexadecimal string (16 bytes, non-zero)
- `parent-id`: 16-character hexadecimal string (8 bytes, non-zero)
- `trace-flags`: 2-character hexadecimal bitmask (`01` indicates recorded/sampled)

### Baggage & Tenant Isolation

- `baggage` preserves contextual metadata across asynchronous job transitions (such as `tenantId`, `userId`, `scanPriority`).
- Strict tenant isolation is maintained by carrying `tenantId` in the trace context and validating that background workers cannot leak or cross tenant execution contexts.

## Carrier Layers

1. **HTTP Headers (`extractFromHttpHeaders` / `injectIntoHttpHeaders`)**:
   - Parses `traceparent`, `baggage`, and `x-tenant-id`.
   - Injects correlated response headers `x-trace-id`, `x-span-id`, `x-tenant-id`.

2. **Job Envelopes (`injectIntoJobEnvelope` / `extractFromJobEnvelope`)**:
   - Wraps asynchronous queue jobs with `_traceContext` containing serialized `traceparent` and `baggage`.
   - When workers pick up jobs, a child context is spawned with the same `traceId` and `parentId` pointing to the job enqueue span.

3. **Active Context Execution (`runWithContext`)**:
   - Backed by Node.js `AsyncLocalStorage`.
   - Ensures any synchronous or asynchronous operations inside worker handlers have access to the active trace context without passing explicit parameters through every function.

## Usage Example

```typescript
import {
  extractFromHttpHeaders,
  injectIntoJobEnvelope,
  extractFromJobEnvelope,
  defaultTraceService,
} from "./common/tracing";

// 1. API Controller: extract from request
const traceCtx = extractFromHttpHeaders(req.headers);

// 2. Queue Job: inject into job payload
const jobPayload = injectIntoJobEnvelope({ repoUrl, commitHash }, traceCtx);
await scanQueue.add("scan", jobPayload);

// 3. Worker: extract and execute within context
const workerTraceCtx = extractFromJobEnvelope(job.data);
await defaultTraceService.runWithContext(workerTraceCtx, async () => {
  const { span } = defaultTraceService.startSpan("ast_parsing");
  try {
    await parseAstFiles();
    defaultTraceService.endSpan(span, "ok");
  } catch (err) {
    defaultTraceService.endSpan(span, "error", err.message);
    throw err;
  }
});
```
