/**
 * Per-repository scan quotas (issue #1194).
 *
 * The scan orchestrator admits work per repository. To stop a single noisy
 * repository from monopolising workers, each repository is bounded twice over:
 * by the number of scans that may be in flight concurrently, and by the number
 * of scans that may be admitted within a rolling time window.
 *
 * The class performs no I/O and never reads the clock itself; callers pass
 * `now`, so admission decisions are deterministic and testable. Quotas are
 * tracked per repository, so exhausting one repository's quota never affects
 * another's (tenant isolation).
 */

export interface ScanQuotaConfig {
  /** Maximum scans that may be in flight for one repository at a time. */
  maxConcurrentPerRepository: number;
  /** Maximum scans that may be admitted for one repository per window. */
  maxScansPerWindow: number;
  /** Length of the rolling admission window, in milliseconds. */
  windowMs: number;
}

export type ScanQuotaRejection =
  | "repository_concurrency_exceeded"
  | "repository_window_exceeded";

export interface ScanQuotaDecision {
  /** Whether the scan may be admitted. */
  allowed: boolean;
  /** Present only when `allowed` is false. */
  reason?: ScanQuotaRejection;
  /**
   * Present only for `repository_window_exceeded`: milliseconds until the
   * oldest admitted scan leaves the window and a slot frees up.
   */
  retryAfterMs?: number;
}

export interface ScanQuotaSnapshot {
  inFlight: number;
  usedInWindow: number;
  maxConcurrentPerRepository: number;
  maxScansPerWindow: number;
  windowMs: number;
}

interface RepositoryState {
  inFlight: number;
  /** Adoption timestamps of scans admitted within the current window. */
  admissions: number[];
}

const DEFAULT_CONFIG: ScanQuotaConfig = {
  maxConcurrentPerRepository: 2,
  maxScansPerWindow: 20,
  windowMs: 60_000,
};

export class RepositoryScanQuota {
  private readonly config: ScanQuotaConfig;
  private readonly repositories: Map<string, RepositoryState> = new Map();

  constructor(config: Partial<ScanQuotaConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateQuotaConfig(this.config);
  }

  /**
   * Attempt to admit a scan for `repositoryId`.
   *
   * Concurrency is checked before the window so a rejected caller always gets
   * the most actionable reason. On success both the concurrency and window
   * counters advance; every admitted scan must later be paired with `release`.
   */
  tryAcquire(repositoryId: string, now: number = Date.now()): ScanQuotaDecision {
    requireNonEmpty(repositoryId, "repositoryId");
    const state = this.stateFor(repositoryId);
    this.prune(state, now);

    if (state.inFlight >= this.config.maxConcurrentPerRepository) {
      return { allowed: false, reason: "repository_concurrency_exceeded" };
    }

    if (state.admissions.length >= this.config.maxScansPerWindow) {
      const oldest = state.admissions[0];
      return {
        allowed: false,
        reason: "repository_window_exceeded",
        retryAfterMs: Math.max(0, oldest + this.config.windowMs - now),
      };
    }

    state.inFlight += 1;
    state.admissions.push(now);
    return { allowed: true };
  }

  /**
   * Release a slot previously taken by `tryAcquire`.
   *
   * Releasing an unknown repository is a no-op, and the in-flight count is
   * floored at zero so an unbalanced release cannot corrupt the quota.
   */
  release(repositoryId: string): void {
    const state = this.repositories.get(repositoryId);
    if (!state) {
      return;
    }
    state.inFlight = Math.max(0, state.inFlight - 1);
  }

  /** Current quota usage for a repository, after expiring stale admissions. */
  snapshot(repositoryId: string, now: number = Date.now()): ScanQuotaSnapshot {
    const state = this.repositories.get(repositoryId);
    if (state) {
      this.prune(state, now);
    }
    return {
      inFlight: state ? state.inFlight : 0,
      usedInWindow: state ? state.admissions.length : 0,
      maxConcurrentPerRepository: this.config.maxConcurrentPerRepository,
      maxScansPerWindow: this.config.maxScansPerWindow,
      windowMs: this.config.windowMs,
    };
  }

  private stateFor(repositoryId: string): RepositoryState {
    let state = this.repositories.get(repositoryId);
    if (!state) {
      state = { inFlight: 0, admissions: [] };
      this.repositories.set(repositoryId, state);
    }
    return state;
  }

  private prune(state: RepositoryState, now: number): void {
    const cutoff = now - this.config.windowMs;
    while (state.admissions.length > 0 && state.admissions[0] <= cutoff) {
      state.admissions.shift();
    }
  }
}

function validateQuotaConfig(config: ScanQuotaConfig): void {
  const keys: Array<keyof ScanQuotaConfig> = [
    "maxConcurrentPerRepository",
    "maxScansPerWindow",
    "windowMs",
  ];
  for (const key of keys) {
    const value = config[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`scan quota ${key} must be a positive integer`);
    }
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
