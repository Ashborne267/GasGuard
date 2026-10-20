import * as crypto from "crypto";

/**
 * W3C Trace Context Specification (#1263).
 *
 * Implements W3C Trace Context Level 1:
 * traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}
 * - version: 2 hex characters ('00')
 * - trace-id: 32 hex characters (cannot be all '0's)
 * - parent-id: 16 hex characters (cannot be all '0's)
 * - trace-flags: 2 hex characters (bit 1 is sampled: 01 vs 00)
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentId?: string;
  sampled: boolean;
  tenantId?: string;
  baggage: Record<string, string>;
  startedAt: number;
}

const TRACEPARENT_REGEX =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZEROS_32 = "00000000000000000000000000000000";
const ALL_ZEROS_16 = "0000000000000000";

/**
 * Validates and parses a W3C traceparent header string.
 * Returns null if the header is malformed, invalid version, or all zeros.
 */
export function parseTraceparent(
  header: string | undefined | null,
): { traceId: string; parentId: string; sampled: boolean } | null {
  if (!header || typeof header !== "string") {
    return null;
  }

  const trimmed = header.trim();
  const match = TRACEPARENT_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, version, traceId, parentId, flags] = match;

  // Version '00' is standard W3C. Future versions must not be ff.
  if (version === "ff") {
    return null;
  }

  // Validate non-zero IDs per W3C specification
  if (
    traceId.toLowerCase() === ALL_ZEROS_32 ||
    parentId.toLowerCase() === ALL_ZEROS_16
  ) {
    return null;
  }

  const flagNum = parseInt(flags, 16);
  const sampled = (flagNum & 0x01) === 0x01;

  return {
    traceId: traceId.toLowerCase(),
    parentId: parentId.toLowerCase(),
    sampled,
  };
}

/**
 * Formats a W3C traceparent header.
 */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled: boolean = true,
): string {
  if (
    !/^[0-9a-f]{32}$/i.test(traceId) ||
    traceId.toLowerCase() === ALL_ZEROS_32
  ) {
    throw new TypeError(
      "traceId must be a 32-character non-zero hexadecimal string",
    );
  }
  if (
    !/^[0-9a-f]{16}$/i.test(spanId) ||
    spanId.toLowerCase() === ALL_ZEROS_16
  ) {
    throw new TypeError(
      "spanId must be a 16-character non-zero hexadecimal string",
    );
  }

  const flags = sampled ? "01" : "00";
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${flags}`;
}

/**
 * Parses W3C baggage header or comma-delimited key=value strings.
 */
export function parseBaggage(
  header: string | undefined | null,
): Record<string, string> {
  if (!header || typeof header !== "string") {
    return {};
  }

  const baggage: Record<string, string> = {};
  const pairs = header.split(",");

  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).trim());
    const val = decodeURIComponent(pair.slice(eqIdx + 1).trim());
    if (key) {
      baggage[key] = val;
    }
  }

  return baggage;
}

/**
 * Formats a key-value record into a W3C baggage header string.
 */
export function formatBaggage(baggage: Record<string, string>): string {
  return Object.entries(baggage)
    .filter(([k, v]) => k && v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(",");
}

/**
 * Generates a valid 32-character hex trace ID.
 */
export function generateTraceId(): string {
  let id = crypto.randomBytes(16).toString("hex");
  while (id === ALL_ZEROS_32) {
    id = crypto.randomBytes(16).toString("hex");
  }
  return id;
}

/**
 * Generates a valid 16-character hex span ID.
 */
export function generateSpanId(): string {
  let id = crypto.randomBytes(8).toString("hex");
  while (id === ALL_ZEROS_16) {
    id = crypto.randomBytes(8).toString("hex");
  }
  return id;
}

/**
 * Initializes a new root trace context.
 */
export function createRootTraceContext(options?: {
  tenantId?: string;
  sampled?: boolean;
  baggage?: Record<string, string>;
}): TraceContext {
  const baggage = { ...(options?.baggage ?? {}) };
  if (options?.tenantId) {
    baggage.tenantId = options.tenantId;
  }

  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    sampled: options?.sampled ?? true,
    tenantId: options?.tenantId,
    baggage,
    startedAt: Date.now(),
  };
}

/**
 * Creates a child span trace context linked to parent.
 * Retains traceId, propagates tenantId and baggage.
 */
export function createChildTraceContext(
  parent: TraceContext,
  options?: {
    extraBaggage?: Record<string, string>;
    overrideTenantId?: string;
  },
): TraceContext {
  if (!parent || !parent.traceId || !parent.spanId) {
    throw new TypeError("parent context must have valid traceId and spanId");
  }

  const baggage = {
    ...parent.baggage,
    ...(options?.extraBaggage ?? {}),
  };

  const tenantId =
    options?.overrideTenantId ?? parent.tenantId ?? baggage.tenantId;
  if (tenantId) {
    baggage.tenantId = tenantId;
  }

  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentId: parent.spanId,
    sampled: parent.sampled,
    tenantId,
    baggage,
    startedAt: Date.now(),
  };
}
