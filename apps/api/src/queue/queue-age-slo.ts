/**
 * Queue age service-level objectives (issue #1201).
 *
 * The scan queue is judged by how long the oldest waiting job has been waiting,
 * not just by throughput. This module classifies a queue age against configured
 * warning and breach thresholds so dashboards and alerts share one definition of
 * "healthy", "warning", and "breached".
 *
 * Thresholds are explicit and validated up front. Ages are always evaluated
 * against an injected `now` so behaviour is deterministic in tests.
 */

export interface QueueAgeSloConfig {
  /** Age at or above which the queue is in `warning`. */
  warningMs: number;
  /** Age at or above which the SLO is `breached`. Must be >= `warningMs`. */
  breachMs: number;
}

export type QueueAgeStatus = "healthy" | "warning" | "breached";

export interface QueueAgeEvaluation {
  status: QueueAgeStatus;
  ageMs: number;
  /** Milliseconds past the breach threshold; present only when breached. */
  breachOverrunMs?: number;
}

export interface QueueAgeSummary {
  status: QueueAgeStatus;
  worstAgeMs: number;
  healthy: number;
  warning: number;
  breached: number;
}

export class QueueAgeSlo {
  private readonly config: QueueAgeSloConfig;

  constructor(config: QueueAgeSloConfig) {
    validateConfig(config);
    this.config = config;
  }

  /**
   * Classify the age of the oldest waiting job.
   *
   * `oldestEnqueuedAt` is the enqueue time of the oldest pending job; a
   * timestamp in the future (clock skew) yields an age of zero rather than a
   * negative value.
   */
  evaluate(
    oldestEnqueuedAt: number,
    now: number = Date.now(),
  ): QueueAgeEvaluation {
    requireFinite(oldestEnqueuedAt, "oldestEnqueuedAt");
    requireFinite(now, "now");

    const ageMs = Math.max(0, now - oldestEnqueuedAt);
    if (ageMs >= this.config.breachMs) {
      return {
        status: "breached",
        ageMs,
        breachOverrunMs: ageMs - this.config.breachMs,
      };
    }
    if (ageMs >= this.config.warningMs) {
      return { status: "warning", ageMs };
    }
    return { status: "healthy", ageMs };
  }

  /** Summarize a batch of ages, classifying each and reporting the worst. */
  evaluateAges(agesMs: number[]): QueueAgeSummary {
    const summary: QueueAgeSummary = {
      status: "healthy",
      worstAgeMs: 0,
      healthy: 0,
      warning: 0,
      breached: 0,
    };

    for (const ageMs of agesMs) {
      requireFinite(ageMs, "ageMs");
      const status = this.classify(ageMs);
      summary[status] += 1;
      summary.worstAgeMs = Math.max(summary.worstAgeMs, ageMs);
      summary.status = worst(summary.status, status);
    }

    return summary;
  }

  /**
   * Fraction of ages within the warning threshold, in `[0, 1]`.
   *
   * An empty batch is fully compliant and returns `1`.
   */
  compliance(agesMs: number[]): number {
    if (agesMs.length === 0) {
      return 1;
    }
    const healthy = agesMs.filter((ageMs) => {
      requireFinite(ageMs, "ageMs");
      return this.classify(ageMs) === "healthy";
    }).length;
    return healthy / agesMs.length;
  }

  private classify(ageMs: number): QueueAgeStatus {
    if (ageMs >= this.config.breachMs) {
      return "breached";
    }
    if (ageMs >= this.config.warningMs) {
      return "warning";
    }
    return "healthy";
  }
}

const SEVERITY: Record<QueueAgeStatus, number> = {
  healthy: 0,
  warning: 1,
  breached: 2,
};

function worst(a: QueueAgeStatus, b: QueueAgeStatus): QueueAgeStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function validateConfig(config: QueueAgeSloConfig): void {
  if (!Number.isInteger(config.warningMs) || config.warningMs <= 0) {
    throw new RangeError("warningMs must be a positive integer");
  }
  if (!Number.isInteger(config.breachMs) || config.breachMs < config.warningMs) {
    throw new RangeError("breachMs must be an integer >= warningMs");
  }
}

function requireFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
}
