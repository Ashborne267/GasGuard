/**
 * Configuration surface for tracking rule performance regression thresholds (#1251).
 */

import { RulePerformanceThresholds } from "./rule-performance-types";

export interface RulePerformanceConfig {
  /** Master switch and kill switch. When false, tracking & evaluations are no-ops. */
  enabled: boolean;
  /** Global default thresholds applied to rules unless overridden. */
  defaultThresholds: RulePerformanceThresholds;
  /** Per-rule threshold overrides keyed by ruleId. */
  ruleOverrides: Record<string, RulePerformanceThresholds>;
  /** Maximum number of execution samples stored or processed per rule. */
  maxSamplesPerRule: number;
  /** Maximum duration allowed in ms before absolute rule failure. */
  maxAllowedDurationMs: number;
  /** Maximum memory allowed in bytes before absolute rule failure. */
  maxAllowedMemoryBytes: number;
  /** How long baselines are retained in milliseconds (default: 30 days). */
  baselineRetentionMs: number;
  /** Maximum allowed tenant ID and repo ID string length. */
  maxIdentifierLength: number;
}

export const DEFAULT_RULE_PERFORMANCE_THRESHOLDS: Readonly<RulePerformanceThresholds> =
  Object.freeze({
    maxDurationMs: 5_000,
    maxDurationDeltaPercent: 50, // +50% regression from baseline
    maxMemoryBytes: 256 * 1024 * 1024, // 256MB
    maxMemoryDeltaPercent: 50, // +50% memory increase
    maxErrorRate: 0.05, // 5% errors
    warningFactor: 0.8, // 80% threshold triggers warning
  });

export const DEFAULT_RULE_PERFORMANCE_CONFIG: Readonly<RulePerformanceConfig> =
  Object.freeze({
    enabled: true,
    defaultThresholds: DEFAULT_RULE_PERFORMANCE_THRESHOLDS,
    ruleOverrides: {},
    maxSamplesPerRule: 1_000,
    maxAllowedDurationMs: 60_000,
    maxAllowedMemoryBytes: 1024 * 1024 * 1024, // 1GB
    baselineRetentionMs: 30 * 24 * 60 * 60 * 1000,
    maxIdentifierLength: 128,
  });

const ENV_KEYS: Record<string, string> = {
  enabled: "RULE_PERFORMANCE_TRACKING_ENABLED",
  maxDurationMs: "RULE_PERFORMANCE_DEFAULT_MAX_DURATION_MS",
  maxDurationDeltaPercent: "RULE_PERFORMANCE_DEFAULT_MAX_DURATION_DELTA_PERCENT",
  maxMemoryBytes: "RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_BYTES",
  maxMemoryDeltaPercent: "RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_DELTA_PERCENT",
  maxErrorRate: "RULE_PERFORMANCE_DEFAULT_MAX_ERROR_RATE",
  warningFactor: "RULE_PERFORMANCE_WARNING_FACTOR",
  maxSamplesPerRule: "RULE_PERFORMANCE_MAX_SAMPLES_PER_RULE",
  maxAllowedDurationMs: "RULE_PERFORMANCE_MAX_ALLOWED_DURATION_MS",
  maxAllowedMemoryBytes: "RULE_PERFORMANCE_MAX_ALLOWED_MEMORY_BYTES",
  baselineRetentionMs: "RULE_PERFORMANCE_BASELINE_RETENTION_MS",
};

export function resolveRulePerformanceConfig(
  overrides: Partial<RulePerformanceConfig> = {},
): RulePerformanceConfig {
  const defaultThresholds: RulePerformanceThresholds = {
    ...DEFAULT_RULE_PERFORMANCE_THRESHOLDS,
    ...(overrides.defaultThresholds || {}),
  };

  validateThresholds(defaultThresholds, "defaultThresholds");

  const config: RulePerformanceConfig = {
    ...DEFAULT_RULE_PERFORMANCE_CONFIG,
    ...stripUndefined(overrides),
    defaultThresholds,
    ruleOverrides: overrides.ruleOverrides ?? {},
  };

  if (typeof config.enabled !== "boolean") {
    throw new RangeError("enabled must be a boolean");
  }

  requirePositiveInteger(config.maxSamplesPerRule, "maxSamplesPerRule");
  requirePositiveInteger(config.maxAllowedDurationMs, "maxAllowedDurationMs");
  requirePositiveInteger(config.maxAllowedMemoryBytes, "maxAllowedMemoryBytes");
  requirePositiveInteger(config.baselineRetentionMs, "baselineRetentionMs");
  requirePositiveInteger(config.maxIdentifierLength, "maxIdentifierLength");

  for (const [ruleId, thresholds] of Object.entries(config.ruleOverrides)) {
    if (!ruleId || ruleId.trim() === "") {
      throw new RangeError("ruleOverrides keys must be non-empty strings");
    }
    validateThresholds(thresholds, `ruleOverrides[${ruleId}]`);
  }

  return config;
}

export function loadRulePerformanceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RulePerformanceConfig {
  const overrides: Partial<RulePerformanceConfig> = {};
  const defaultThresholds: Partial<RulePerformanceThresholds> = {};

  const enabledRaw = env[ENV_KEYS.enabled];
  if (enabledRaw !== undefined && enabledRaw.trim() !== "") {
    overrides.enabled = parseBoolean(enabledRaw.trim(), ENV_KEYS.enabled);
  }

  const durationRaw = env[ENV_KEYS.maxDurationMs];
  if (durationRaw !== undefined && durationRaw.trim() !== "") {
    defaultThresholds.maxDurationMs = parseNumber(durationRaw.trim(), ENV_KEYS.maxDurationMs);
  }

  const durationDeltaRaw = env[ENV_KEYS.maxDurationDeltaPercent];
  if (durationDeltaRaw !== undefined && durationDeltaRaw.trim() !== "") {
    defaultThresholds.maxDurationDeltaPercent = parseNumber(
      durationDeltaRaw.trim(),
      ENV_KEYS.maxDurationDeltaPercent,
    );
  }

  const memoryRaw = env[ENV_KEYS.maxMemoryBytes];
  if (memoryRaw !== undefined && memoryRaw.trim() !== "") {
    defaultThresholds.maxMemoryBytes = parseNumber(memoryRaw.trim(), ENV_KEYS.maxMemoryBytes);
  }

  const memoryDeltaRaw = env[ENV_KEYS.maxMemoryDeltaPercent];
  if (memoryDeltaRaw !== undefined && memoryDeltaRaw.trim() !== "") {
    defaultThresholds.maxMemoryDeltaPercent = parseNumber(
      memoryDeltaRaw.trim(),
      ENV_KEYS.maxMemoryDeltaPercent,
    );
  }

  const errorRateRaw = env[ENV_KEYS.maxErrorRate];
  if (errorRateRaw !== undefined && errorRateRaw.trim() !== "") {
    defaultThresholds.maxErrorRate = parseNumber(errorRateRaw.trim(), ENV_KEYS.maxErrorRate);
  }

  const warningFactorRaw = env[ENV_KEYS.warningFactor];
  if (warningFactorRaw !== undefined && warningFactorRaw.trim() !== "") {
    defaultThresholds.warningFactor = parseNumber(warningFactorRaw.trim(), ENV_KEYS.warningFactor);
  }

  const samplesRaw = env[ENV_KEYS.maxSamplesPerRule];
  if (samplesRaw !== undefined && samplesRaw.trim() !== "") {
    overrides.maxSamplesPerRule = parseNumber(samplesRaw.trim(), ENV_KEYS.maxSamplesPerRule);
  }

  const maxAllowedDurationRaw = env[ENV_KEYS.maxAllowedDurationMs];
  if (maxAllowedDurationRaw !== undefined && maxAllowedDurationRaw.trim() !== "") {
    overrides.maxAllowedDurationMs = parseNumber(
      maxAllowedDurationRaw.trim(),
      ENV_KEYS.maxAllowedDurationMs,
    );
  }

  const maxAllowedMemoryRaw = env[ENV_KEYS.maxAllowedMemoryBytes];
  if (maxAllowedMemoryRaw !== undefined && maxAllowedMemoryRaw.trim() !== "") {
    overrides.maxAllowedMemoryBytes = parseNumber(
      maxAllowedMemoryRaw.trim(),
      ENV_KEYS.maxAllowedMemoryBytes,
    );
  }

  const retentionRaw = env[ENV_KEYS.baselineRetentionMs];
  if (retentionRaw !== undefined && retentionRaw.trim() !== "") {
    overrides.baselineRetentionMs = parseNumber(
      retentionRaw.trim(),
      ENV_KEYS.baselineRetentionMs,
    );
  }

  if (Object.keys(defaultThresholds).length > 0) {
    overrides.defaultThresholds = defaultThresholds;
  }

  return resolveRulePerformanceConfig(overrides);
}

function validateThresholds(thresholds: RulePerformanceThresholds, context: string): void {
  if (thresholds.maxDurationMs !== undefined) {
    requirePositiveInteger(thresholds.maxDurationMs, `${context}.maxDurationMs`);
  }
  if (thresholds.maxDurationDeltaPercent !== undefined) {
    requireNonNegativeNumber(
      thresholds.maxDurationDeltaPercent,
      `${context}.maxDurationDeltaPercent`,
    );
  }
  if (thresholds.maxMemoryBytes !== undefined) {
    requirePositiveInteger(thresholds.maxMemoryBytes, `${context}.maxMemoryBytes`);
  }
  if (thresholds.maxMemoryDeltaPercent !== undefined) {
    requireNonNegativeNumber(
      thresholds.maxMemoryDeltaPercent,
      `${context}.maxMemoryDeltaPercent`,
    );
  }
  if (thresholds.maxErrorRate !== undefined) {
    requireRatio(thresholds.maxErrorRate, `${context}.maxErrorRate`);
  }
  if (thresholds.warningFactor !== undefined) {
    requireRatio(thresholds.warningFactor, `${context}.warningFactor`);
  }
}

function parseBoolean(value: string, envKey: string): boolean {
  const lowered = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  throw new RangeError(`${envKey} must be a boolean`);
}

function parseNumber(value: string, envKey: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${envKey} must be a number`);
  }
  return parsed;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function requireNonNegativeNumber(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative number`);
  }
}

function requireRatio(value: number, field: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${field} must be a number between 0 and 1`);
  }
}
