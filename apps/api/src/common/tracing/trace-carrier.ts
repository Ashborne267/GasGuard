import {
  createChildTraceContext,
  createRootTraceContext,
  formatBaggage,
  formatTraceparent,
  generateSpanId,
  parseBaggage,
  parseTraceparent,
  TraceContext,
} from "./trace-context";

export interface HttpHeadersCarrier {
  [header: string]: string | string[] | undefined;
}

export interface JobEnvelopeWithTrace {
  payload?: any;
  _traceContext?: {
    traceparent: string;
    tracestate?: string;
    baggage?: string;
    tenantId?: string;
    startedAt?: number;
  };
  [key: string]: any;
}

/**
 * Extracts a TraceContext from incoming HTTP request headers.
 * Supports W3C traceparent, baggage, and fallback headers (x-correlation-id, x-request-id, x-tenant-id).
 */
export function extractFromHttpHeaders(
  headers: HttpHeadersCarrier,
): TraceContext {
  const getHeader = (name: string): string | undefined => {
    const val = headers[name.toLowerCase()] ?? headers[name];
    if (Array.isArray(val)) {
      return val[0];
    }
    return val;
  };

  const traceparentHeader = getHeader("traceparent");
  const baggageHeader = getHeader("baggage");
  const tenantIdHeader = getHeader("x-tenant-id");

  const parsed = parseTraceparent(traceparentHeader);
  const baggage = parseBaggage(baggageHeader);

  const tenantId = tenantIdHeader || baggage.tenantId || undefined;
  if (tenantId) {
    baggage.tenantId = tenantId;
  }

  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: generateSpanId(),
      parentId: parsed.parentId,
      sampled: parsed.sampled,
      tenantId,
      baggage,
      startedAt: Date.now(),
    };
  }

  // Fallback to x-correlation-id or x-request-id if valid 32-char hex, or create new root trace
  return createRootTraceContext({
    tenantId,
    baggage,
  });
}

/**
 * Injects TraceContext into outgoing HTTP headers.
 */
export function injectIntoHttpHeaders(
  context: TraceContext,
  headers: Record<string, string> = {},
): Record<string, string> {
  headers["traceparent"] = formatTraceparent(
    context.traceId,
    context.spanId,
    context.sampled,
  );

  const baggageStr = formatBaggage(context.baggage);
  if (baggageStr) {
    headers["baggage"] = baggageStr;
  }

  if (context.tenantId) {
    headers["x-tenant-id"] = context.tenantId;
  }

  headers["x-trace-id"] = context.traceId;
  headers["x-span-id"] = context.spanId;

  return headers;
}

/**
 * Injects trace context into a queue job payload/envelope.
 */
export function injectIntoJobEnvelope<T extends Record<string, any>>(
  jobData: T,
  context: TraceContext,
): T & JobEnvelopeWithTrace {
  const traceparent = formatTraceparent(
    context.traceId,
    context.spanId,
    context.sampled,
  );
  const baggage = formatBaggage(context.baggage);

  return {
    ...jobData,
    _traceContext: {
      traceparent,
      ...(baggage ? { baggage } : {}),
      ...(context.tenantId ? { tenantId: context.tenantId } : {}),
      startedAt: context.startedAt,
    },
  };
}

/**
 * Extracts and restores TraceContext from a job payload/envelope.
 * Returns child trace context linked to the job's span.
 */
export function extractFromJobEnvelope(jobData: any): TraceContext {
  if (!jobData || typeof jobData !== "object") {
    return createRootTraceContext();
  }

  const envelope = jobData._traceContext;
  if (!envelope || !envelope.traceparent) {
    // Check if directly in payload or fallback
    const tenantId = jobData.tenantId || jobData.payload?.tenantId;
    return createRootTraceContext({ tenantId });
  }

  const parsed = parseTraceparent(envelope.traceparent);
  if (!parsed) {
    return createRootTraceContext({ tenantId: envelope.tenantId });
  }

  const baggage = parseBaggage(envelope.baggage);
  const tenantId = envelope.tenantId || baggage.tenantId;
  if (tenantId) {
    baggage.tenantId = tenantId;
  }

  const parentContext: TraceContext = {
    traceId: parsed.traceId,
    spanId: parsed.parentId,
    sampled: parsed.sampled,
    tenantId,
    baggage,
    startedAt: envelope.startedAt ?? Date.now(),
  };

  return createChildTraceContext(parentContext);
}
