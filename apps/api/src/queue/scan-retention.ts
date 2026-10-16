/**
 * Configurable scan retention windows (issue #1200).
 *
 * Scan results are retained for a bounded period that depends on the tenant's
 * tier. This policy resolves the retention window for a tier, computes when a
 * scan expires, and selects the scans that a retention job should purge.
 *
 * Retention is expressed as an explicit per-tier window so the same policy can
 * be reused by the API, the purge worker, and off-chain reporting. An unknown
 * tier is rejected rather than silently treated as the default, so a renamed or
 * removed tier cannot cause results to be retained or deleted unintentionally.
 */

export interface RetentionWindow {
  /** Tenant or plan tier the window applies to. */
  tier: string;
  /** How long scans of this tier are retained, in milliseconds. */
  retentionMs: number;
}

export interface RetainedScan {
  scanId: string;
  tier: string;
  createdAt: number;
}

export class ScanRetentionPolicy {
  private readonly windows: Map<string, number> = new Map();
  private readonly defaultTier?: string;

  /**
   * @param windows One entry per supported tier. Non-empty and unique by tier.
   * @param defaultTier Optional tier used when a caller does not specify one.
   *   Must be one of `windows`.
   */
  constructor(windows: RetentionWindow[], defaultTier?: string) {
    if (!Array.isArray(windows) || windows.length === 0) {
      throw new RangeError("retention windows must be a non-empty array");
    }

    for (const window of windows) {
      if (typeof window.tier !== "string" || window.tier.trim() === "") {
        throw new TypeError("retention window tier must be a non-empty string");
      }
      if (!Number.isInteger(window.retentionMs) || window.retentionMs <= 0) {
        throw new RangeError(
          `retention window for tier "${window.tier}" must be a positive integer`,
        );
      }
      if (this.windows.has(window.tier)) {
        throw new RangeError(`duplicate retention window for tier "${window.tier}"`);
      }
      this.windows.set(window.tier, window.retentionMs);
    }

    if (defaultTier !== undefined) {
      if (!this.windows.has(defaultTier)) {
        throw new RangeError(
          `default tier "${defaultTier}" has no retention window`,
        );
      }
      this.defaultTier = defaultTier;
    }
  }

  /** Tiers this policy knows about, in insertion order. */
  tiers(): string[] {
    return [...this.windows.keys()];
  }

  /**
   * Retention window for `tier`. Falls back to the configured default tier when
   * `tier` is omitted, and throws for an unknown tier.
   */
  retentionMsFor(tier?: string): number {
    const resolved = tier ?? this.defaultTier;
    if (resolved === undefined) {
      throw new RangeError("no tier supplied and no default tier configured");
    }
    const retentionMs = this.windows.get(resolved);
    if (retentionMs === undefined) {
      throw new RangeError(`unknown retention tier "${resolved}"`);
    }
    return retentionMs;
  }

  /** Timestamp at which a scan of `tier` created at `createdAt` expires. */
  expiresAt(createdAt: number, tier?: string): number {
    return createdAt + this.retentionMsFor(tier);
  }

  /**
   * Whether a scan is eligible for purging.
   *
   * A scan is expired once `now` reaches its expiry boundary, i.e. at exactly
   * `createdAt + retentionMs`.
   */
  isExpired(createdAt: number, tier?: string, now: number = Date.now()): boolean {
    return now >= this.expiresAt(createdAt, tier);
  }

  /**
   * Scan ids that a retention run should purge, in input order.
   *
   * Scans whose tier is unknown cause an error so a misconfigured tier is never
   * purged silently.
   */
  selectExpired(scans: RetainedScan[], now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const scan of scans) {
      // Resolves (and validates) the tier even for scans that are not expired.
      const retentionMs = this.retentionMsFor(scan.tier);
      if (now >= scan.createdAt + retentionMs) {
        expired.push(scan.scanId);
      }
    }
    return expired;
  }
}
