import {
  HealthProbe,
  HealthProbeRegistry,
  resolveHealthProbeThresholds,
  sanitizeProbeTarget,
  DEFAULT_HEALTH_PROBE_THRESHOLDS,
} from "./health-probe";
import { HealthCheckService } from "./health-check";

describe("Health Probe Configurable Thresholds (#1266)", () => {
  describe("resolveHealthProbeThresholds", () => {
    it("returns default thresholds when no overrides given", () => {
      const config = resolveHealthProbeThresholds();
      expect(config).toEqual(DEFAULT_HEALTH_PROBE_THRESHOLDS);
    });

    it("accepts valid partial overrides", () => {
      const config = resolveHealthProbeThresholds({
        healthyLatencyMsThreshold: 200,
        degradedLatencyMsThreshold: 800,
        unhealthyLatencyMsThreshold: 2000,
        consecutiveFailuresThreshold: 5,
        consecutiveSuccessesThreshold: 3,
      });

      expect(config.healthyLatencyMsThreshold).toBe(200);
      expect(config.degradedLatencyMsThreshold).toBe(800);
      expect(config.unhealthyLatencyMsThreshold).toBe(2000);
      expect(config.consecutiveFailuresThreshold).toBe(5);
      expect(config.consecutiveSuccessesThreshold).toBe(3);
      expect(config.timeoutMs).toBe(DEFAULT_HEALTH_PROBE_THRESHOLDS.timeoutMs);
    });

    it("rejects non-positive or non-integer thresholds", () => {
      expect(() => resolveHealthProbeThresholds({ timeoutMs: 0 })).toThrow(RangeError);
      expect(() => resolveHealthProbeThresholds({ timeoutMs: -100 })).toThrow(RangeError);
      expect(() => resolveHealthProbeThresholds({ timeoutMs: 15.5 })).toThrow(RangeError);
      expect(() => resolveHealthProbeThresholds({ consecutiveFailuresThreshold: -1 })).toThrow(RangeError);
      expect(() => resolveHealthProbeThresholds({ windowSize: 0 })).toThrow(RangeError);
    });

    it("rejects non-monotonic latency thresholds", () => {
      expect(() =>
        resolveHealthProbeThresholds({
          healthyLatencyMsThreshold: 1000,
          degradedLatencyMsThreshold: 500,
        }),
      ).toThrow(RangeError);

      expect(() =>
        resolveHealthProbeThresholds({
          degradedLatencyMsThreshold: 3000,
          unhealthyLatencyMsThreshold: 2000,
        }),
      ).toThrow(RangeError);
    });

    it("rejects invalid failure rate thresholds", () => {
      expect(() => resolveHealthProbeThresholds({ failureRateDegradedThreshold: -0.1 })).toThrow(RangeError);
      expect(() => resolveHealthProbeThresholds({ failureRateDegradedThreshold: 1.5 })).toThrow(RangeError);
      expect(() =>
        resolveHealthProbeThresholds({
          failureRateDegradedThreshold: 0.6,
          failureRateUnhealthyThreshold: 0.4,
        }),
      ).toThrow(RangeError);
    });
  });

  describe("sanitizeProbeTarget", () => {
    it("redacts query params containing secret keys or tokens", () => {
      const url = "https://eth-node.example.com?api_key=secret123&foo=bar";
      const sanitized = sanitizeProbeTarget(url);
      expect(sanitized).toBe("https://eth-node.example.com?api_key=[REDACTED]&foo=bar");
      expect(sanitized).not.toContain("secret123");
    });

    it("redacts basic auth credentials from URLs", () => {
      const url = "https://user:pass1234@stellar-node.example.com/rpc";
      const sanitized = sanitizeProbeTarget(url);
      expect(sanitized).toBe("https://user:[REDACTED]@stellar-node.example.com/rpc");
      expect(sanitized).not.toContain("pass1234");
    });

    it("handles empty or non-string inputs safely", () => {
      expect(sanitizeProbeTarget("")).toBe("");
      expect(sanitizeProbeTarget(null as unknown as string)).toBe("");
    });
  });

  describe("HealthProbe state transitions", () => {
    it("starts in unknown state before any samples", () => {
      const probe = new HealthProbe("test-rpc");
      const evalReport = probe.evaluate();
      expect(evalReport.status).toBe("unknown");
      expect(evalReport.isHealthy).toBe(false);
      expect(evalReport.samplesCount).toBe(0);
    });

    it("becomes healthy when samples are within healthy latency and alive", () => {
      const probe = new HealthProbe("test-rpc", {
        healthyLatencyMsThreshold: 300,
        degradedLatencyMsThreshold: 1000,
        unhealthyLatencyMsThreshold: 3000,
      });

      const res = probe.recordSample({ isAlive: true, latencyMs: 150 });
      expect(res.status).toBe("healthy");
      expect(res.isHealthy).toBe(true);
      expect(res.consecutiveSuccesses).toBe(1);
      expect(res.consecutiveFailures).toBe(0);
      expect(res.failureRate).toBe(0);
    });

    it("becomes degraded when latency exceeds degraded threshold", () => {
      const probe = new HealthProbe("test-rpc", {
        healthyLatencyMsThreshold: 300,
        degradedLatencyMsThreshold: 800,
        unhealthyLatencyMsThreshold: 2000,
      });

      probe.recordSample({ isAlive: true, latencyMs: 100 });
      const res = probe.recordSample({ isAlive: true, latencyMs: 900 });
      expect(res.status).toBe("degraded");
      expect(res.isHealthy).toBe(false);
      expect(res.reasons.some((r) => r.includes("breached degraded latency threshold"))).toBe(true);
    });

    it("becomes unhealthy when latency exceeds unhealthy threshold", () => {
      const probe = new HealthProbe("test-rpc", {
        healthyLatencyMsThreshold: 300,
        degradedLatencyMsThreshold: 800,
        unhealthyLatencyMsThreshold: 2000,
      });

      const res = probe.recordSample({ isAlive: true, latencyMs: 2500 });
      expect(res.status).toBe("unhealthy");
      expect(res.isHealthy).toBe(false);
      expect(res.reasons.some((r) => r.includes("breached unhealthy latency threshold"))).toBe(true);
    });

    it("transitions from degraded to unhealthy upon reaching consecutive failures threshold", () => {
      const probe = new HealthProbe("test-rpc", {
        consecutiveFailuresThreshold: 3,
        healthyLatencyMsThreshold: 500,
      });

      // 1st failure -> degraded
      let evalReport = probe.recordSample({ isAlive: false, latencyMs: 100 });
      expect(evalReport.status).toBe("degraded");

      // 2nd failure -> still degraded
      evalReport = probe.recordSample({ isAlive: false, latencyMs: 100 });
      expect(evalReport.status).toBe("degraded");

      // 3rd failure -> trips to unhealthy!
      evalReport = probe.recordSample({ isAlive: false, latencyMs: 100 });
      expect(evalReport.status).toBe("unhealthy");
      expect(evalReport.consecutiveFailures).toBe(3);
    });

    it("enforces consecutiveSuccessesThreshold before recovering to healthy", () => {
      const probe = new HealthProbe("test-rpc", {
        consecutiveFailuresThreshold: 2,
        consecutiveSuccessesThreshold: 2,
      });

      // Trip to unhealthy
      probe.recordSample({ isAlive: false, latencyMs: 50 });
      probe.recordSample({ isAlive: false, latencyMs: 50 });
      expect(probe.getStatus()).toBe("unhealthy");

      // 1st success -> moves to degraded (recovering), not fully healthy yet
      let evalReport = probe.recordSample({ isAlive: true, latencyMs: 50 });
      expect(evalReport.status).toBe("degraded");
      expect(evalReport.consecutiveSuccesses).toBe(1);

      // 2nd success -> recovers to healthy!
      evalReport = probe.recordSample({ isAlive: true, latencyMs: 50 });
      expect(evalReport.status).toBe("healthy");
      expect(evalReport.isHealthy).toBe(true);
    });

    it("trips to unhealthy when sliding window failure rate exceeds threshold", () => {
      const probe = new HealthProbe("test-rpc", {
        windowSize: 4,
        failureRateDegradedThreshold: 0.25,
        failureRateUnhealthyThreshold: 0.5,
        consecutiveFailuresThreshold: 10, // high so consecutive won't trigger
        minSamplesForFailureRate: 3,
      });

      probe.recordSample({ isAlive: true, latencyMs: 50 });
      probe.recordSample({ isAlive: false, latencyMs: 50 });
      probe.recordSample({ isAlive: true, latencyMs: 50 });
      // 1 failure out of 3 = 0.33 -> degraded
      expect(probe.getStatus()).toBe("degraded");

      // Another failure: 2 failures out of 4 = 0.5 -> unhealthy!
      const res = probe.recordSample({ isAlive: false, latencyMs: 50 });
      expect(res.status).toBe("unhealthy");
      expect(res.failureRate).toBe(0.5);
    });

    it("bounds window size by evicting oldest samples", () => {
      const probe = new HealthProbe("test-rpc", { windowSize: 3 });
      probe.recordSample({ isAlive: true, latencyMs: 10 });
      probe.recordSample({ isAlive: true, latencyMs: 20 });
      probe.recordSample({ isAlive: true, latencyMs: 30 });
      probe.recordSample({ isAlive: true, latencyMs: 40 });

      const evaluation = probe.evaluate();
      expect(evaluation.samplesCount).toBe(3);
      // Average of 20, 30, 40 = 30
      expect(evaluation.averageLatencyMs).toBe(30);
    });

    it("resets state cleanly", () => {
      const probe = new HealthProbe("test-rpc");
      probe.recordSample({ isAlive: true, latencyMs: 50 });
      expect(probe.evaluate().samplesCount).toBe(1);

      probe.reset();
      expect(probe.evaluate().samplesCount).toBe(0);
      expect(probe.getStatus()).toBe("unknown");
    });

    it("validates invalid constructor parameters", () => {
      expect(() => new HealthProbe("")).toThrow(TypeError);
      expect(() => new HealthProbe("   ")).toThrow(TypeError);
    });

    it("validates invalid recordSample parameters", () => {
      const probe = new HealthProbe("test");
      expect(() => probe.recordSample({ isAlive: "yes" as any, latencyMs: 10 })).toThrow(TypeError);
      expect(() => probe.recordSample({ isAlive: true, latencyMs: -10 })).toThrow(RangeError);
      expect(() => probe.recordSample({ isAlive: true, latencyMs: NaN })).toThrow(RangeError);
    });
  });

  describe("executeProbe async with timeout", () => {
    it("records success when probe function resolves in time", async () => {
      const probe = new HealthProbe("test-async", { timeoutMs: 1000 });
      const res = await probe.executeProbe(async () => {
        return { latencyMs: 42, metadata: { status: 200 } };
      });

      expect(res.status).toBe("healthy");
      expect(res.isHealthy).toBe(true);
      expect(res.averageLatencyMs).toBe(42);
    });

    it("records failure when probe function throws", async () => {
      const probe = new HealthProbe("test-async");
      const res = await probe.executeProbe(async () => {
        throw new Error("Connection refused");
      });

      expect(res.isHealthy).toBe(false);
      expect(res.consecutiveFailures).toBe(1);
    });

    it("records failure when probe function times out", async () => {
      const probe = new HealthProbe("test-timeout", { timeoutMs: 30 });
      const res = await probe.executeProbe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(res.isHealthy).toBe(false);
      expect(res.consecutiveFailures).toBe(1);
    });
  });

  describe("HealthProbeRegistry", () => {
    it("registers and retrieves probes by name", () => {
      const registry = new HealthProbeRegistry();
      const probe = registry.registerProbe("redis", { timeoutMs: 2000 });
      expect(registry.getProbe("redis")).toBe(probe);
      expect(registry.hasProbe("redis")).toBe(true);
      expect(registry.getOrCreateProbe("redis")).toBe(probe);
    });

    it("aggregates status across multiple probes accurately", () => {
      const registry = new HealthProbeRegistry();
      const rpc = registry.registerProbe("rpc");
      const redis = registry.registerProbe("redis");
      const worker = registry.registerProbe("worker");

      // rpc healthy
      rpc.recordSample({ isAlive: true, latencyMs: 50 });
      // redis healthy
      redis.recordSample({ isAlive: true, latencyMs: 10 });
      // worker degraded
      worker.recordSample({ isAlive: true, latencyMs: 1800 });

      const report = registry.aggregateHealth();
      expect(report.healthyCount).toBe(2);
      expect(report.degradedCount).toBe(1);
      expect(report.unhealthyCount).toBe(0);
      expect(report.overallStatus).toBe("degraded");

      // worker trips to unhealthy
      worker.recordSample({ isAlive: false, latencyMs: 50 });
      worker.recordSample({ isAlive: false, latencyMs: 50 });
      worker.recordSample({ isAlive: false, latencyMs: 50 });

      const report2 = registry.aggregateHealth();
      expect(report2.unhealthyCount).toBe(1);
      expect(report2.overallStatus).toBe("unhealthy");
    });

    it("removes probes and handles clear", () => {
      const registry = new HealthProbeRegistry();
      registry.registerProbe("rpc");
      expect(registry.removeProbe("rpc")).toBe(true);
      expect(registry.hasProbe("rpc")).toBe(false);

      registry.registerProbe("a");
      registry.registerProbe("b");
      registry.clear();
      expect(registry.aggregateHealth().overallStatus).toBe("unknown");
    });
  });

  describe("HealthCheckService integration", () => {
    it("instantiates with custom thresholds and checks endpoints", async () => {
      const svc = new HealthCheckService({
        healthyLatencyMsThreshold: 250,
        degradedLatencyMsThreshold: 1000,
      });

      expect(svc.getRegistry()).toBeInstanceOf(HealthProbeRegistry);
    });
  });
});
