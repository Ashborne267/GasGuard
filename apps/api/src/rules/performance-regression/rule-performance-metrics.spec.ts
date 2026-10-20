import {
  ConsoleRulePerformanceLogger,
  NoopRulePerformanceMetrics,
  RulePerformanceMetrics,
  sanitizeLogFields,
} from "./rule-performance-metrics";

describe("RulePerformanceMetrics and Logging", () => {
  describe("sanitizeLogFields", () => {
    it("strips sensitive tokens, keys, passwords, and file paths", () => {
      const sensitive = {
        tenantId: "tenant-1",
        status: "breached",
        apiToken: "secret-token-123",
        privateKey: "0xabcdef",
        password: "supersecretpassword",
        filePath: "/usr/src/secret/contract.sol",
        sourceCode: "contract Foo {}",
        nested: {
          authToken: "bearer 123",
          ruleId: "soroban-storage-rent",
        },
      };

      const sanitized = sanitizeLogFields(sensitive);
      expect(sanitized.tenantId).toBe("tenant-1");
      expect(sanitized.status).toBe("breached");
      expect(sanitized.apiToken).toBeUndefined();
      expect(sanitized.privateKey).toBeUndefined();
      expect(sanitized.password).toBeUndefined();
      expect(sanitized.filePath).toBeUndefined();
      expect(sanitized.sourceCode).toBeUndefined();

      const nested = sanitized.nested as Record<string, unknown>;
      expect(nested.authToken).toBeUndefined();
      expect(nested.ruleId).toBe("soroban-storage-rent");
    });

    it("handles Error instances safely", () => {
      const fields = {
        error: new Error("Validation failure"),
      };
      const sanitized = sanitizeLogFields(fields);
      expect(sanitized.error).toBe("Validation failure");
    });
  });

  describe("ConsoleRulePerformanceLogger", () => {
    it("logs without throwing", () => {
      const logger = new ConsoleRulePerformanceLogger("debug");
      expect(() => {
        logger.debug("test_debug", { count: 1 });
        logger.info("test_info", { tenantId: "tenant-1" });
        logger.warn("test_warn", { warning: true });
        logger.error("test_error", { error: "fatal" });
      }).not.toThrow();
    });
  });

  describe("RulePerformanceMetrics", () => {
    it("allows recording metrics via NoopRulePerformanceMetrics", () => {
      const metrics: RulePerformanceMetrics = new NoopRulePerformanceMetrics();
      expect(() => {
        metrics.incrementEvaluations({ status: "passed" });
        metrics.incrementBreaches({
          ruleId: "soroban-storage-rent",
          metric: "duration_ms",
          severity: "breach",
        });
        metrics.incrementErrors({ code: "STORE_UNAVAILABLE" });
        metrics.observeEvaluationDuration(0.045);
        metrics.observeRuleDuration({ ruleId: "soroban-storage-rent" }, 0.012);
      }).not.toThrow();
    });
  });
});
