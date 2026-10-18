import {
  DEFAULT_RULE_PERFORMANCE_CONFIG,
  loadRulePerformanceConfigFromEnv,
  resolveRulePerformanceConfig,
} from "./rule-performance-config";

describe("RulePerformanceConfig", () => {
  describe("resolveRulePerformanceConfig", () => {
    it("returns default values when overrides are empty", () => {
      const config = resolveRulePerformanceConfig();
      expect(config.enabled).toBe(true);
      expect(config.defaultThresholds.maxDurationMs).toBe(5_000);
      expect(config.defaultThresholds.maxDurationDeltaPercent).toBe(50);
      expect(config.defaultThresholds.maxMemoryBytes).toBe(256 * 1024 * 1024);
      expect(config.defaultThresholds.maxErrorRate).toBe(0.05);
      expect(config.defaultThresholds.warningFactor).toBe(0.8);
      expect(config.maxSamplesPerRule).toBe(1_000);
      expect(config.baselineRetentionMs).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("merges valid overrides correctly", () => {
      const config = resolveRulePerformanceConfig({
        enabled: false,
        defaultThresholds: {
          maxDurationMs: 3_000,
          maxDurationDeltaPercent: 25,
        },
        maxSamplesPerRule: 500,
      });

      expect(config.enabled).toBe(false);
      expect(config.defaultThresholds.maxDurationMs).toBe(3_000);
      expect(config.defaultThresholds.maxDurationDeltaPercent).toBe(25);
      expect(config.defaultThresholds.maxMemoryBytes).toBe(256 * 1024 * 1024);
      expect(config.maxSamplesPerRule).toBe(500);
    });

    it("rejects non-boolean enabled", () => {
      expect(() =>
        resolveRulePerformanceConfig({ enabled: "true" as unknown as boolean }),
      ).toThrow("enabled must be a boolean");
    });

    it("rejects non-positive integers", () => {
      expect(() =>
        resolveRulePerformanceConfig({ maxSamplesPerRule: 0 }),
      ).toThrow("maxSamplesPerRule must be a positive integer");
      expect(() =>
        resolveRulePerformanceConfig({ defaultThresholds: { maxDurationMs: -10 } }),
      ).toThrow("defaultThresholds.maxDurationMs must be a positive integer");
    });

    it("rejects invalid error rate ratio", () => {
      expect(() =>
        resolveRulePerformanceConfig({ defaultThresholds: { maxErrorRate: 1.5 } }),
      ).toThrow("defaultThresholds.maxErrorRate must be a number between 0 and 1");
      expect(() =>
        resolveRulePerformanceConfig({ defaultThresholds: { maxErrorRate: -0.1 } }),
      ).toThrow("defaultThresholds.maxErrorRate must be a number between 0 and 1");
    });

    it("validates rule overrides", () => {
      const config = resolveRulePerformanceConfig({
        ruleOverrides: {
          "custom-rule": { maxDurationMs: 10_000 },
        },
      });
      expect(config.ruleOverrides["custom-rule"].maxDurationMs).toBe(10_000);

      expect(() =>
        resolveRulePerformanceConfig({
          ruleOverrides: { "": { maxDurationMs: 100 } },
        }),
      ).toThrow("ruleOverrides keys must be non-empty strings");
    });
  });

  describe("loadRulePerformanceConfigFromEnv", () => {
    it("loads configuration from environment variables", () => {
      const env: Record<string, string> = {
        RULE_PERFORMANCE_TRACKING_ENABLED: "false",
        RULE_PERFORMANCE_DEFAULT_MAX_DURATION_MS: "2500",
        RULE_PERFORMANCE_DEFAULT_MAX_DURATION_DELTA_PERCENT: "30",
        RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_BYTES: "1000000",
        RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_DELTA_PERCENT: "40",
        RULE_PERFORMANCE_DEFAULT_MAX_ERROR_RATE: "0.02",
        RULE_PERFORMANCE_WARNING_FACTOR: "0.75",
        RULE_PERFORMANCE_MAX_SAMPLES_PER_RULE: "200",
      };

      const config = loadRulePerformanceConfigFromEnv(env);
      expect(config.enabled).toBe(false);
      expect(config.defaultThresholds.maxDurationMs).toBe(2500);
      expect(config.defaultThresholds.maxDurationDeltaPercent).toBe(30);
      expect(config.defaultThresholds.maxMemoryBytes).toBe(1000000);
      expect(config.defaultThresholds.maxMemoryDeltaPercent).toBe(40);
      expect(config.defaultThresholds.maxErrorRate).toBe(0.02);
      expect(config.defaultThresholds.warningFactor).toBe(0.75);
      expect(config.maxSamplesPerRule).toBe(200);
    });

    it("throws on unparseable numbers in env", () => {
      expect(() =>
        loadRulePerformanceConfigFromEnv({
          RULE_PERFORMANCE_DEFAULT_MAX_DURATION_MS: "not-a-number",
        }),
      ).toThrow("RULE_PERFORMANCE_DEFAULT_MAX_DURATION_MS must be a number");
    });
  });
});
