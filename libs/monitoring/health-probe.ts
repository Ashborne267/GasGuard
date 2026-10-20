/**
 * Configurable Health Probe Thresholds (#1266).
 *
 * Provides configurable health evaluation for platform subsystems (RPC nodes,
 * Redis connection pools, background worker pools, analyzer modules).
 *
 * Distinguishes between Healthy, Degraded, and Unhealthy based on configurable
 * latency thresholds, consecutive failure/success counts, and sliding window
 * failure rates. Logs and metrics exclude credentials and private parameters.
 */

export type HealthProbeStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unknown";

export interface HealthProbeThresholds {
  /** Maximum latency in ms considered fully healthy (e.g. 500ms). */
  healthyLatencyMsThreshold: number;
  /** Latency threshold in ms above which probe status becomes degraded (e.g. 1500ms). */
  degradedLatencyMsThreshold: number;
  /** Latency threshold in ms above which probe status becomes unhealthy (e.g. 5000ms). */
  unhealthyLatencyMsThreshold: number;
  /** Consecutive errors needed to mark probe as unhealthy. */
  consecutiveFailuresThreshold: number;
  /** Consecutive successes needed to recover from degraded/unhealthy to healthy. */
  consecutiveSuccessesThreshold: number;
  /** Sliding window failure rate [0, 1] that trips status to degraded. */
  failureRateDegradedThreshold: number;
  /** Sliding window failure rate [0, 1] that trips status to unhealthy. */
  failureRateUnhealthyThreshold: number;
  /** Probe execution timeout in milliseconds. */
  timeoutMs: number;
  /** Number of historical probe results retained in the sliding window. */
  windowSize: number;
  /** Minimum samples required before evaluating sliding window failure rate. */
  minSamplesForFailureRate: number;
}

export const DEFAULT_HEALTH_PROBE_THRESHOLDS: HealthProbeThresholds = {
  healthyLatencyMsThreshold: 500,
  degradedLatencyMsThreshold: 1500,
  unhealthyLatencyMsThreshold: 5000,
  consecutiveFailuresThreshold: 3,
  consecutiveSuccessesThreshold: 2,
  failureRateDegradedThreshold: 0.2, // 20%
  failureRateUnhealthyThreshold: 0.5, // 50%
  timeoutMs: 5000,
  windowSize: 20,
  minSamplesForFailureRate: 5,
};

export interface ProbeResult {
  probeName: string;
  timestamp: number;
  isAlive: boolean;
  latencyMs: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface ProbeEvaluation {
  probeName: string;
  status: HealthProbeStatus;
  isHealthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  samplesCount: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  failureRate: number;
  reasons: string[];
  lastCheckedAt?: number;
}

export interface AggregatedHealthReport {
  overallStatus: HealthProbeStatus;
  timestamp: number;
  healthyCount: number;
  degradedCount: number;
  unhealthyCount: number;
  unknownCount: number;
  probes: Record<string, ProbeEvaluation>;
}

/**
 * Validates and resolves HealthProbeThresholds from optional overrides.
 */
export function resolveHealthProbeThresholds(
  overrides?: Partial<HealthProbeThresholds>,
): HealthProbeThresholds {
  if (!overrides) {
    return { ...DEFAULT_HEALTH_PROBE_THRESHOLDS };
  }

  const resolved = { ...DEFAULT_HEALTH_PROBE_THRESHOLDS, ...overrides };

  // Validate positive integer thresholds
  const positiveIntegers: Array<keyof HealthProbeThresholds> = [
    "healthyLatencyMsThreshold",
    "degradedLatencyMsThreshold",
    "unhealthyLatencyMsThreshold",
    "consecutiveFailuresThreshold",
    "consecutiveSuccessesThreshold",
    "timeoutMs",
    "windowSize",
    "minSamplesForFailureRate",
  ];

  for (const field of positiveIntegers) {
    const val = resolved[field];
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      throw new RangeError(`${field} must be a positive integer`);
    }
  }

  // Validate monotonic latency thresholds
  if (
    resolved.healthyLatencyMsThreshold >= resolved.degradedLatencyMsThreshold
  ) {
    throw new RangeError(
      "healthyLatencyMsThreshold must be less than degradedLatencyMsThreshold",
    );
  }
  if (
    resolved.degradedLatencyMsThreshold >= resolved.unhealthyLatencyMsThreshold
  ) {
    throw new RangeError(
      "degradedLatencyMsThreshold must be less than unhealthyLatencyMsThreshold",
    );
  }

  // Validate failure rates in [0, 1]
  if (
    typeof resolved.failureRateDegradedThreshold !== "number" ||
    Number.isNaN(resolved.failureRateDegradedThreshold) ||
    resolved.failureRateDegradedThreshold < 0 ||
    resolved.failureRateDegradedThreshold > 1
  ) {
    throw new RangeError(
      "failureRateDegradedThreshold must be a number between 0 and 1",
    );
  }

  if (
    typeof resolved.failureRateUnhealthyThreshold !== "number" ||
    Number.isNaN(resolved.failureRateUnhealthyThreshold) ||
    resolved.failureRateUnhealthyThreshold < 0 ||
    resolved.failureRateUnhealthyThreshold > 1
  ) {
    throw new RangeError(
      "failureRateUnhealthyThreshold must be a number between 0 and 1",
    );
  }

  if (
    resolved.failureRateDegradedThreshold >=
    resolved.failureRateUnhealthyThreshold
  ) {
    throw new RangeError(
      "failureRateDegradedThreshold must be less than failureRateUnhealthyThreshold",
    );
  }

  return resolved;
}

/**
 * Sanitizes URLs, keys, and tokens to prevent leaking credentials in health logs/evaluations.
 */
export function sanitizeProbeTarget(rawTarget: string): string {
  if (!rawTarget || typeof rawTarget !== "string") {
    return "";
  }
  return rawTarget
    .replace(
      /(api[_-]?key|token|auth|secret|password)=([^&]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/:\/\/([^:]+):([^@]+)@/g, "://$1:[REDACTED]@");
}

export class HealthProbe {
  readonly probeName: string;
  private readonly thresholds: HealthProbeThresholds;
  private readonly results: ProbeResult[] = [];
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private currentStatus: HealthProbeStatus = "unknown";

  constructor(probeName: string, thresholds?: Partial<HealthProbeThresholds>) {
    if (
      !probeName ||
      typeof probeName !== "string" ||
      probeName.trim() === ""
    ) {
      throw new TypeError("probeName must be a non-empty string");
    }
    this.probeName = probeName.trim();
    this.thresholds = resolveHealthProbeThresholds(thresholds);
  }

  getThresholds(): HealthProbeThresholds {
    return { ...this.thresholds };
  }

  getStatus(): HealthProbeStatus {
    return this.currentStatus;
  }

  /**
   * Records a probe execution sample and updates internal status.
   */
  recordSample(sample: {
    isAlive: boolean;
    latencyMs: number;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
    timestamp?: number;
  }): ProbeEvaluation {
    if (typeof sample.isAlive !== "boolean") {
      throw new TypeError("sample.isAlive must be a boolean");
    }
    if (
      typeof sample.latencyMs !== "number" ||
      Number.isNaN(sample.latencyMs) ||
      sample.latencyMs < 0
    ) {
      throw new RangeError("sample.latencyMs must be a non-negative number");
    }

    const timestamp = sample.timestamp ?? Date.now();
    const sanitizedError = sample.errorMessage
      ? sanitizeProbeTarget(sample.errorMessage)
      : undefined;

    const probeResult: ProbeResult = {
      probeName: this.probeName,
      timestamp,
      isAlive: sample.isAlive,
      latencyMs: sample.latencyMs,
      ...(sanitizedError ? { errorMessage: sanitizedError } : {}),
      ...(sample.metadata ? { metadata: sample.metadata } : {}),
    };

    this.results.push(probeResult);
    if (this.results.length > this.thresholds.windowSize) {
      this.results.shift();
    }

    if (!sample.isAlive) {
      this.consecutiveFailures += 1;
      this.consecutiveSuccesses = 0;
    } else {
      this.consecutiveSuccesses += 1;
      this.consecutiveFailures = 0;
    }

    return this.evaluate(timestamp);
  }

  /**
   * Executes an asynchronous probe function with timeout enforcement.
   */
  async executeProbe(
    probeFn: () => Promise<void | {
      latencyMs?: number;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<ProbeEvaluation> {
    const start = Date.now();
    let isAlive = false;
    let latencyMs = 0;
    let errorMessage: string | undefined;
    let metadata: Record<string, unknown> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`Probe timed out after ${this.thresholds.timeoutMs}ms`),
          );
        }, this.thresholds.timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      });

      const res = await Promise.race([probeFn(), timeoutPromise]);
      isAlive = true;
      latencyMs =
        res?.latencyMs !== undefined ? res.latencyMs : Date.now() - start;
      metadata = res?.metadata;
    } catch (err: unknown) {
      isAlive = false;
      latencyMs = Date.now() - start;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    return this.recordSample({
      isAlive,
      latencyMs,
      errorMessage,
      metadata,
      timestamp: Date.now(),
    });
  }

  /**
   * Evaluates current health status based on configured thresholds.
   */
  evaluate(now: number = Date.now()): ProbeEvaluation {
    if (this.results.length === 0) {
      return {
        probeName: this.probeName,
        status: "unknown",
        isHealthy: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        samplesCount: 0,
        averageLatencyMs: 0,
        p95LatencyMs: 0,
        failureRate: 0,
        reasons: ["No samples recorded"],
        lastCheckedAt: undefined,
      };
    }

    const latencies = this.results
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);
    const sumLatency = latencies.reduce((acc, curr) => acc + curr, 0);
    const avgLatency = sumLatency / latencies.length;
    const p95Latency = calculatePercentile(latencies, 0.95);

    const failedCount = this.results.filter((r) => !r.isAlive).length;
    const failureRate = failedCount / this.results.length;

    const reasons: string[] = [];
    let isUnhealthy = false;
    let isDegraded = false;

    const hasEnoughSamples =
      this.results.length >= this.thresholds.minSamplesForFailureRate;

    // Check Unhealthy criteria
    if (
      this.consecutiveFailures >= this.thresholds.consecutiveFailuresThreshold
    ) {
      isUnhealthy = true;
      reasons.push(
        `Consecutive failures (${this.consecutiveFailures}) reached threshold (${this.thresholds.consecutiveFailuresThreshold})`,
      );
    }
    if (
      hasEnoughSamples &&
      failureRate >= this.thresholds.failureRateUnhealthyThreshold
    ) {
      isUnhealthy = true;
      reasons.push(
        `Failure rate (${(failureRate * 100).toFixed(1)}%) reached unhealthy threshold (${(this.thresholds.failureRateUnhealthyThreshold * 100).toFixed(1)}%)`,
      );
    }
    const latestSample = this.results[this.results.length - 1];
    if (
      latestSample &&
      latestSample.latencyMs >= this.thresholds.unhealthyLatencyMsThreshold
    ) {
      isUnhealthy = true;
      reasons.push(
        `Latency (${latestSample.latencyMs}ms) breached unhealthy latency threshold (${this.thresholds.unhealthyLatencyMsThreshold}ms)`,
      );
    }

    // Check Degraded criteria if not unhealthy
    if (!isUnhealthy) {
      if (this.consecutiveFailures > 0) {
        isDegraded = true;
        reasons.push(
          `Latest probe failed (${this.consecutiveFailures} consecutive failure)`,
        );
      }
      if (
        hasEnoughSamples &&
        failureRate >= this.thresholds.failureRateDegradedThreshold
      ) {
        isDegraded = true;
        reasons.push(
          `Failure rate (${(failureRate * 100).toFixed(1)}%) reached degraded threshold (${(this.thresholds.failureRateDegradedThreshold * 100).toFixed(1)}%)`,
        );
      }
      if (
        latestSample &&
        latestSample.latencyMs >= this.thresholds.degradedLatencyMsThreshold
      ) {
        isDegraded = true;
        reasons.push(
          `Latency (${latestSample.latencyMs}ms) breached degraded latency threshold (${this.thresholds.degradedLatencyMsThreshold}ms)`,
        );
      }
    }

    // Recovery logic: if currently degraded or unhealthy, require consecutiveSuccessesThreshold
    let determinedStatus: HealthProbeStatus = "healthy";
    if (isUnhealthy) {
      determinedStatus = "unhealthy";
    } else if (isDegraded) {
      determinedStatus = "degraded";
    } else {
      // It meets healthy conditions now, check if recovering
      if (
        (this.currentStatus === "unhealthy" ||
          this.currentStatus === "degraded") &&
        this.consecutiveSuccesses <
          this.thresholds.consecutiveSuccessesThreshold
      ) {
        determinedStatus = "degraded";
        reasons.push(
          `Recovering: consecutive successes (${this.consecutiveSuccesses}) below recovery threshold (${this.thresholds.consecutiveSuccessesThreshold})`,
        );
      } else {
        determinedStatus = "healthy";
        reasons.push("All thresholds within healthy bounds");
      }
    }

    this.currentStatus = determinedStatus;

    return {
      probeName: this.probeName,
      status: this.currentStatus,
      isHealthy: this.currentStatus === "healthy",
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      samplesCount: this.results.length,
      averageLatencyMs: Math.round(avgLatency),
      p95LatencyMs: Math.round(p95Latency),
      failureRate: Math.round(failureRate * 1000) / 1000,
      reasons,
      lastCheckedAt: latestSample?.timestamp,
    };
  }

  reset(): void {
    this.results.length = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.currentStatus = "unknown";
  }
}

/**
 * Registry to register, manage, and aggregate multiple named HealthProbes.
 */
export class HealthProbeRegistry {
  private readonly probes: Map<string, HealthProbe> = new Map();

  registerProbe(
    probeName: string,
    thresholds?: Partial<HealthProbeThresholds>,
  ): HealthProbe {
    if (
      !probeName ||
      typeof probeName !== "string" ||
      probeName.trim() === ""
    ) {
      throw new TypeError("probeName must be a non-empty string");
    }
    const key = probeName.trim();
    const probe = new HealthProbe(key, thresholds);
    this.probes.set(key, probe);
    return probe;
  }

  getProbe(probeName: string): HealthProbe | undefined {
    return this.probes.get(probeName.trim());
  }

  getOrCreateProbe(
    probeName: string,
    thresholds?: Partial<HealthProbeThresholds>,
  ): HealthProbe {
    const existing = this.getProbe(probeName);
    if (existing) {
      return existing;
    }
    return this.registerProbe(probeName, thresholds);
  }

  hasProbe(probeName: string): boolean {
    return this.probes.has(probeName.trim());
  }

  removeProbe(probeName: string): boolean {
    return this.probes.delete(probeName.trim());
  }

  aggregateHealth(now: number = Date.now()): AggregatedHealthReport {
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;
    let unknownCount = 0;
    const probeReports: Record<string, ProbeEvaluation> = {};

    for (const [name, probe] of this.probes.entries()) {
      const evaluation = probe.evaluate(now);
      probeReports[name] = evaluation;

      switch (evaluation.status) {
        case "healthy":
          healthyCount += 1;
          break;
        case "degraded":
          degradedCount += 1;
          break;
        case "unhealthy":
          unhealthyCount += 1;
          break;
        case "unknown":
          unknownCount += 1;
          break;
      }
    }

    let overallStatus: HealthProbeStatus = "healthy";
    if (unhealthyCount > 0) {
      overallStatus = "unhealthy";
    } else if (degradedCount > 0 || (unknownCount > 0 && healthyCount === 0)) {
      overallStatus = "degraded";
    } else if (this.probes.size === 0) {
      overallStatus = "unknown";
    }

    return {
      overallStatus,
      timestamp: now,
      healthyCount,
      degradedCount,
      unhealthyCount,
      unknownCount,
      probes: probeReports,
    };
  }

  clear(): void {
    this.probes.clear();
  }
}

function calculatePercentile(
  sorted: readonly number[],
  quantile: number,
): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(quantile * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}
