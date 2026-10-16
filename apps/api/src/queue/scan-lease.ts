/**
 * Scan lease expiration handling (issue #1197).
 *
 * Only one worker may hold a scan at a time. A lease grants that exclusivity for
 * a bounded window; if the holder dies, the lease expires and another worker can
 * take over. Every grant carries a monotonically increasing fencing token so a
 * stalled former holder cannot renew or release a lease that has since been
 * re-issued to someone else.
 *
 * The manager reads time through an injected clock, so expiry behaviour is
 * deterministic and testable.
 */

export interface ScanLease {
  scanId: string;
  /** Worker that currently holds the lease. */
  owner: string;
  /** Fencing token, incremented on every new grant for this scan. */
  token: number;
  acquiredAt: number;
  expiresAt: number;
}

export type LeaseAcquireResult =
  | { granted: true; lease: ScanLease }
  | { granted: false; heldBy: string; expiresAt: number };

export class ScanLeaseManager {
  private readonly leaseTtlMs: number;
  private readonly clock: () => number;
  private readonly leases: Map<string, ScanLease> = new Map();
  /** Highest fencing token ever issued per scan, kept across reclamation. */
  private readonly tokens: Map<string, number> = new Map();

  constructor(leaseTtlMs: number, clock: () => number = Date.now) {
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    this.leaseTtlMs = leaseTtlMs;
    this.clock = clock;
  }

  /**
   * Attempt to take the lease for `scanId`.
   *
   * Succeeds when the scan is unheld or its previous lease has expired, in
   * which case a fresh fencing token is issued. While another owner holds a
   * live lease the call reports who holds it instead of granting.
   */
  acquire(scanId: string, owner: string): LeaseAcquireResult {
    requireNonEmpty(scanId, "scanId");
    requireNonEmpty(owner, "owner");
    const now = this.clock();

    const current = this.leases.get(scanId);
    if (current && !this.isExpiredAt(current, now)) {
      return {
        granted: false,
        heldBy: current.owner,
        expiresAt: current.expiresAt,
      };
    }

    const token = (this.tokens.get(scanId) ?? 0) + 1;
    this.tokens.set(scanId, token);
    const lease: ScanLease = {
      scanId,
      owner,
      token,
      acquiredAt: now,
      expiresAt: now + this.leaseTtlMs,
    };
    this.leases.set(scanId, lease);
    return { granted: true, lease };
  }

  /**
   * Extend a live lease that still belongs to `owner` with the current token.
   *
   * Returns false for an unknown, expired, or fencing-stale lease so a stalled
   * holder cannot resurrect exclusivity it has already lost.
   */
  renew(scanId: string, owner: string, token: number): boolean {
    const now = this.clock();
    const lease = this.leases.get(scanId);
    if (!lease || this.isExpiredAt(lease, now)) {
      return false;
    }
    if (lease.owner !== owner || lease.token !== token) {
      return false;
    }
    lease.expiresAt = now + this.leaseTtlMs;
    return true;
  }

  /** Release a lease held by `owner` with the current token. */
  release(scanId: string, owner: string, token: number): boolean {
    const lease = this.leases.get(scanId);
    if (!lease || lease.owner !== owner || lease.token !== token) {
      return false;
    }
    this.leases.delete(scanId);
    return true;
  }

  /** The live lease for `scanId`, or undefined when absent or expired. */
  get(scanId: string): ScanLease | undefined {
    const lease = this.leases.get(scanId);
    if (!lease) {
      return undefined;
    }
    if (this.isExpiredAt(lease, this.clock())) {
      return undefined;
    }
    return lease;
  }

  /** Remove every expired lease and return the reclaimed scan ids. */
  reclaimExpired(): string[] {
    const now = this.clock();
    const reclaimed: string[] = [];
    for (const [scanId, lease] of this.leases) {
      if (this.isExpiredAt(lease, now)) {
        this.leases.delete(scanId);
        reclaimed.push(scanId);
      }
    }
    return reclaimed;
  }

  /** Number of live (unexpired) leases. */
  activeCount(): number {
    this.reclaimExpired();
    return this.leases.size;
  }

  private isExpiredAt(lease: ScanLease, now: number): boolean {
    return now >= lease.expiresAt;
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
