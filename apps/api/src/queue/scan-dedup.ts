/**
 * Scan deduplication by commit SHA (issue #1195).
 *
 * Two scan requests for the same repository at the same commit describe the
 * same logical job. The deduplicator maps `(repositoryId, commitSha)` to the
 * scan id that first claimed it, so concurrent workers converge on a single
 * scan instead of scanning the same revision twice.
 *
 * Entries expire after `ttlMs`, after which the revision may be scanned again
 * (for example once the original result is no longer retained). Deduplication
 * is scoped per repository: identical SHAs in different repositories never
 * collide, preserving tenant isolation.
 */

export interface ScanDeduplicationEntry {
  repositoryId: string;
  commitSha: string;
  scanId: string;
  createdAt: number;
}

export type ScanDeduplicationOutcome =
  | { status: "new"; scanId: string }
  | { status: "duplicate"; existingScanId: string };

/** Abbreviated (>=7) or full (<=64) lowercase hexadecimal commit SHA. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class ScanDeduplicator {
  private readonly ttlMs: number;
  private readonly entries: Map<string, ScanDeduplicationEntry> = new Map();

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive integer");
    }
    this.ttlMs = ttlMs;
  }

  /**
   * Claim `(repositoryId, commitSha)` for `scanId`.
   *
   * Returns `{ status: "new" }` when the revision was unclaimed, or
   * `{ status: "duplicate", existingScanId }` pointing at the scan that already
   * owns it. The commit SHA is normalized (trimmed and lower-cased) first.
   */
  register(
    repositoryId: string,
    commitSha: string,
    scanId: string,
    now: number = Date.now(),
  ): ScanDeduplicationOutcome {
    requireNonEmpty(repositoryId, "repositoryId");
    requireNonEmpty(scanId, "scanId");
    const normalizedSha = normalizeCommitSha(commitSha);

    const key = deduplicationKey(repositoryId, normalizedSha);
    const existing = this.get(key, now);
    if (existing) {
      return { status: "duplicate", existingScanId: existing.scanId };
    }

    this.entries.set(key, {
      repositoryId,
      commitSha: normalizedSha,
      scanId,
      createdAt: now,
    });
    return { status: "new", scanId };
  }

  /** The scan id owning `(repositoryId, commitSha)`, if unexpired. */
  lookup(
    repositoryId: string,
    commitSha: string,
    now: number = Date.now(),
  ): string | undefined {
    requireNonEmpty(repositoryId, "repositoryId");
    const normalizedSha = normalizeCommitSha(commitSha);
    return this.get(deduplicationKey(repositoryId, normalizedSha), now)?.scanId;
  }

  /** Drop the entry for a revision, allowing it to be scanned again. */
  invalidate(repositoryId: string, commitSha: string): boolean {
    requireNonEmpty(repositoryId, "repositoryId");
    const normalizedSha = normalizeCommitSha(commitSha);
    return this.entries.delete(deduplicationKey(repositoryId, normalizedSha));
  }

  /** Number of live (unexpired) entries, pruning stale ones as a side effect. */
  size(now: number = Date.now()): number {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
      }
    }
    return this.entries.size;
  }

  private get(key: string, now: number): ScanDeduplicationEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry, now)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private isExpired(entry: ScanDeduplicationEntry, now: number): boolean {
    return now >= entry.createdAt + this.ttlMs;
  }
}

function deduplicationKey(repositoryId: string, commitSha: string): string {
  return `${repositoryId}\u0000${commitSha}`;
}

function normalizeCommitSha(commitSha: string): string {
  if (typeof commitSha !== "string") {
    throw new TypeError("commitSha must be a string");
  }
  const normalized = commitSha.trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(normalized)) {
    throw new TypeError(
      "commitSha must be a 7-64 character hexadecimal string",
    );
  }
  return normalized;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}
