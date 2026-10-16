import { RepositoryScanQuota } from "./scan-quota";

describe("RepositoryScanQuota", () => {
  it("admits scans up to the concurrency limit and reports usage", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 2,
      maxScansPerWindow: 10,
      windowMs: 60_000,
    });

    expect(quota.tryAcquire("repo-a", 1_000)).toEqual({ allowed: true });
    expect(quota.tryAcquire("repo-a", 1_000)).toEqual({ allowed: true });
    expect(quota.snapshot("repo-a", 1_000)).toMatchObject({
      inFlight: 2,
      usedInWindow: 2,
    });
  });

  it("rejects the scan that would exceed concurrency", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 1,
      maxScansPerWindow: 10,
      windowMs: 60_000,
    });

    expect(quota.tryAcquire("repo-a", 1_000)).toEqual({ allowed: true });
    expect(quota.tryAcquire("repo-a", 1_000)).toEqual({
      allowed: false,
      reason: "repository_concurrency_exceeded",
    });
  });

  it("frees concurrency capacity on release", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 1,
      maxScansPerWindow: 10,
      windowMs: 60_000,
    });

    quota.tryAcquire("repo-a", 1_000);
    expect(quota.tryAcquire("repo-a", 1_000).allowed).toBe(false);

    quota.release("repo-a");
    expect(quota.tryAcquire("repo-a", 1_000)).toEqual({ allowed: true });
  });

  it("rejects once the window quota is used and reports a retry delay", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 5,
      maxScansPerWindow: 2,
      windowMs: 60_000,
    });

    quota.tryAcquire("repo-a", 1_000);
    quota.tryAcquire("repo-a", 2_000);
    const decision = quota.tryAcquire("repo-a", 3_000);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("repository_window_exceeded");
    // Oldest admission at 1_000 leaves the window at 61_000.
    expect(decision.retryAfterMs).toBe(58_000);
  });

  it("keeps an admission inside the window and expires it at the boundary", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 5,
      maxScansPerWindow: 1,
      windowMs: 1_000,
    });

    quota.tryAcquire("repo-a", 10_000);
    // One millisecond before the window closes the slot is still taken.
    expect(quota.tryAcquire("repo-a", 10_999).reason).toBe(
      "repository_window_exceeded",
    );
    // Exactly at the boundary the entry has expired.
    expect(quota.tryAcquire("repo-a", 11_000)).toEqual({ allowed: true });
  });

  it("tracks repositories independently", () => {
    const quota = new RepositoryScanQuota({
      maxConcurrentPerRepository: 1,
      maxScansPerWindow: 1,
      windowMs: 60_000,
    });

    expect(quota.tryAcquire("repo-a", 1_000).allowed).toBe(true);
    expect(quota.tryAcquire("repo-a", 1_000).allowed).toBe(false);
    // A different repository is unaffected by repo-a's exhaustion.
    expect(quota.tryAcquire("repo-b", 1_000).allowed).toBe(true);
  });

  it("floors the in-flight count so an unbalanced release cannot corrupt it", () => {
    const quota = new RepositoryScanQuota({ maxConcurrentPerRepository: 1 });
    quota.release("unknown");
    quota.release("repo-a");
    expect(quota.snapshot("repo-a").inFlight).toBe(0);
  });

  it("rejects invalid configuration", () => {
    expect(() => new RepositoryScanQuota({ windowMs: 0 })).toThrow(RangeError);
    expect(
      () => new RepositoryScanQuota({ maxConcurrentPerRepository: -1 }),
    ).toThrow(RangeError);
    expect(() => new RepositoryScanQuota({ maxScansPerWindow: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("rejects an empty repository id", () => {
    const quota = new RepositoryScanQuota();
    expect(() => quota.tryAcquire("")).toThrow(TypeError);
    expect(() => quota.tryAcquire("   ")).toThrow(TypeError);
  });
});
