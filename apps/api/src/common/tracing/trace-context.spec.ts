import {
  parseTraceparent,
  formatTraceparent,
  parseBaggage,
  formatBaggage,
  generateTraceId,
  generateSpanId,
  createRootTraceContext,
  createChildTraceContext,
} from "./trace-context";
import {
  extractFromHttpHeaders,
  injectIntoHttpHeaders,
  extractFromJobEnvelope,
  injectIntoJobEnvelope,
} from "./trace-carrier";
import { TracePropagationService } from "./trace-propagation.service";

describe("W3C Trace Context and Carrier (#1263)", () => {
  describe("parseTraceparent and formatTraceparent", () => {
    it("parses valid standard W3C traceparent headers", () => {
      const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceparent(header);
      expect(parsed).not.toBeNull();
      expect(parsed!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(parsed!.parentId).toBe("00f067aa0ba902b7");
      expect(parsed!.sampled).toBe(true);
    });

    it("parses unsampled traceparent flag", () => {
      const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
      const parsed = parseTraceparent(header);
      expect(parsed!.sampled).toBe(false);
    });

    it("rejects invalid formats, wrong lengths, or non-hex characters", () => {
      expect(parseTraceparent("not-a-traceparent")).toBeNull();
      expect(parseTraceparent("00-shorttrace-00f067aa0ba902b7-01")).toBeNull();
      expect(
        parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-shortspan-01"),
      ).toBeNull();
      expect(
        parseTraceparent(
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-xyz",
        ),
      ).toBeNull();
      expect(
        parseTraceparent(
          "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        ),
      ).toBeNull();
      expect(parseTraceparent("")).toBeNull();
      expect(parseTraceparent(null)).toBeNull();
    });

    it("rejects all-zeros traceId or parentId per W3C specification", () => {
      expect(
        parseTraceparent(
          "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        ),
      ).toBeNull();
      expect(
        parseTraceparent(
          "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        ),
      ).toBeNull();
    });

    it("formats valid traceparent header string", () => {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const spanId = "00f067aa0ba902b7";
      const formatted = formatTraceparent(traceId, spanId, true);
      expect(formatted).toBe(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      );
    });

    it("throws when formatting with invalid traceId or spanId", () => {
      expect(() => formatTraceparent("invalid", "00f067aa0ba902b7")).toThrow(
        TypeError,
      );
      expect(() =>
        formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "short"),
      ).toThrow(TypeError);
    });
  });

  describe("parseBaggage and formatBaggage", () => {
    it("parses comma-separated key-value pairs with URL decoding", () => {
      const raw = "userId=alice,role=admin,tenantId=acme-corp%20ltd";
      const baggage = parseBaggage(raw);
      expect(baggage.userId).toBe("alice");
      expect(baggage.role).toBe("admin");
      expect(baggage.tenantId).toBe("acme-corp ltd");
    });

    it("formats baggage object into standard string", () => {
      const formatted = formatBaggage({ userId: "alice", tenantId: "acme" });
      expect(formatted).toContain("userId=alice");
      expect(formatted).toContain("tenantId=acme");
    });

    it("handles empty or malformed baggage headers safely", () => {
      expect(parseBaggage("")).toEqual({});
      expect(parseBaggage("malformed-no-equal")).toEqual({});
      expect(parseBaggage(undefined)).toEqual({});
    });
  });

  describe("ID Generators and Context Creation", () => {
    it("generates 32-hex character traceId and 16-hex character spanId", () => {
      const traceId = generateTraceId();
      const spanId = generateSpanId();
      expect(traceId).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(traceId)).toBe(true);
      expect(spanId).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(spanId)).toBe(true);
    });

    it("creates root context and propagates traceId to child context", () => {
      const root = createRootTraceContext({
        tenantId: "tenant-99",
        baggage: { env: "production" },
      });

      expect(root.traceId).toBeDefined();
      expect(root.parentId).toBeUndefined();
      expect(root.tenantId).toBe("tenant-99");
      expect(root.baggage.env).toBe("production");

      const child = createChildTraceContext(root, {
        extraBaggage: { step: "parsing" },
      });

      expect(child.traceId).toBe(root.traceId);
      expect(child.parentId).toBe(root.spanId);
      expect(child.spanId).not.toBe(root.spanId);
      expect(child.tenantId).toBe("tenant-99");
      expect(child.baggage.step).toBe("parsing");
      expect(child.baggage.env).toBe("production");
    });
  });

  describe("Trace Carriers (HTTP and Job Envelopes)", () => {
    it("extracts from HTTP headers and injects into outgoing headers", () => {
      const incomingHeaders = {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "tenantId=tenant-corp,region=us-east",
      };

      const extracted = extractFromHttpHeaders(incomingHeaders);
      expect(extracted.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(extracted.parentId).toBe("00f067aa0ba902b7");
      expect(extracted.tenantId).toBe("tenant-corp");

      const outgoing: Record<string, string> = {};
      injectIntoHttpHeaders(extracted, outgoing);
      expect(outgoing.traceparent).toMatch(
        /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
      );
      expect(outgoing["x-tenant-id"]).toBe("tenant-corp");
      expect(outgoing["x-trace-id"]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    });

    it("injects trace context into job envelope and extracts it in worker", () => {
      const rootCtx = createRootTraceContext({
        tenantId: "tenant-worker-test",
      });
      const jobData = {
        scanId: "scan-job-42",
        repositoryUrl: "https://github.com/MDTechLabs/GasGuard",
      };

      const enqueuedData = injectIntoJobEnvelope(jobData, rootCtx);
      expect(enqueuedData._traceContext).toBeDefined();
      expect(enqueuedData._traceContext?.tenantId).toBe("tenant-worker-test");

      const workerCtx = extractFromJobEnvelope(enqueuedData);
      expect(workerCtx.traceId).toBe(rootCtx.traceId);
      expect(workerCtx.parentId).toBe(rootCtx.spanId);
      expect(workerCtx.tenantId).toBe("tenant-worker-test");
    });
  });
});
