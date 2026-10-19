import { TracePropagationService } from "./trace-propagation.service";
import { createRootTraceContext } from "./trace-context";
import { injectIntoJobEnvelope, extractFromJobEnvelope } from "./trace-carrier";

describe("Trace Propagation End-to-End Across API and Workers (#1263)", () => {
  it("propagates traceId from API request into BullMQ-style job envelope and worker span execution", async () => {
    const traceService = new TracePropagationService();

    // 1. In API gateway: incoming request initializes or extracts trace context
    const apiContext = createRootTraceContext({
      tenantId: "tenant-enterprise-1",
      baggage: { user: "security-auditor", route: "POST /v1/scans" },
    });

    // 2. API enqueues job with trace context injected
    const apiJobPayload = {
      scanId: "scan-e2e-101",
      repo: "https://github.com/MDTechLabs/GasGuard",
      commit: "a1b2c3d4",
    };
    const queuedEnvelope = injectIntoJobEnvelope(apiJobPayload, apiContext);

    // 3. Worker dequeues job and extracts context
    const workerContext = extractFromJobEnvelope(queuedEnvelope);
    expect(workerContext.traceId).toBe(apiContext.traceId);
    expect(workerContext.parentId).toBe(apiContext.spanId);
    expect(workerContext.tenantId).toBe("tenant-enterprise-1");

    // 4. Worker executes scan pipeline inside AsyncLocalStorage context
    await traceService.runWithContext(workerContext, async (ctx) => {
      expect(traceService.getActiveContext()?.traceId).toBe(apiContext.traceId);

      // Start child span for AST parsing
      const { span: parseSpan } = traceService.startSpan("ast_parsing", {
        stage: "parsing",
        language: "solidity",
      });
      expect(parseSpan.traceId).toBe(apiContext.traceId);
      expect(parseSpan.parentId).toBe(workerContext.spanId);

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 15));
      traceService.endSpan(parseSpan, "ok");

      // Start child span for Rule Evaluation
      const { span: evalSpan } = traceService.startSpan("rules_evaluation", {
        stage: "analysis",
      });
      expect(evalSpan.traceId).toBe(apiContext.traceId);
      expect(evalSpan.parentId).toBe(workerContext.spanId);

      await new Promise((resolve) => setTimeout(resolve, 10));
      traceService.endSpan(evalSpan, "ok");
    });

    const completed = traceService.getCompletedSpans();
    expect(completed).toHaveLength(2);
    expect(completed[0].operationName).toBe("ast_parsing");
    expect(completed[0].status).toBe("ok");
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(10);
    expect(completed[1].operationName).toBe("rules_evaluation");
    expect(completed[1].status).toBe("ok");
  });

  it("handles high concurrency of distinct jobs across multiple tenants without context bleeding", async () => {
    const traceService = new TracePropagationService();
    const concurrentJobsCount = 20;

    const runJob = async (id: number) => {
      const tenantId = `tenant-${id % 3}`;
      const rootCtx = createRootTraceContext({
        tenantId,
        baggage: { jobId: `job-${id}` },
      });

      const envelope = injectIntoJobEnvelope({ jobId: `job-${id}` }, rootCtx);
      const workerCtx = extractFromJobEnvelope(envelope);

      return traceService.runWithContext(workerCtx, async () => {
        // Interleaved delays
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));

        const active = traceService.getActiveContext();
        expect(active?.traceId).toBe(rootCtx.traceId);
        expect(active?.tenantId).toBe(tenantId);
        expect(active?.baggage.jobId).toBe(`job-${id}`);

        const { span } = traceService.startSpan(`scan-task-${id}`);
        expect(span.traceId).toBe(rootCtx.traceId);
        expect(span.tenantId).toBe(tenantId);
        traceService.endSpan(span, "ok");

        return span.traceId;
      });
    };

    const traceIds = await Promise.all(
      Array.from({ length: concurrentJobsCount }, (_, i) => runJob(i)),
    );

    // Verify all trace IDs are distinct
    const uniqueIds = new Set(traceIds);
    expect(uniqueIds.size).toBe(concurrentJobsCount);
  });
});
