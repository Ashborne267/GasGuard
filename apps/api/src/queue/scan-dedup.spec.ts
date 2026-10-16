import { ScanDeduplicator } from "./scan-dedup";

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

describe("ScanDeduplicator", () => {
  it("accepts a revision the first time it is seen", () => {
    const dedup = new ScanDeduplicator();
    expect(dedup.register("repo-a", SHA, "scan-1", 1_000)).toEqual({
      status: "new",
      scanId: "scan-1",
    });
  });

  it("returns the existing scan for a duplicate revision", () => {
    const dedup = new ScanDeduplicator();
    dedup.register("repo-a", SHA, "scan-1", 1_000);

    expect(dedup.register("repo-a", SHA, "scan-2", 1_500)).toEqual({
      status: "duplicate",
      existingScanId: "scan-1",
    });
    expect(dedup.lookup("repo-a", SHA, 1_500)).toBe("scan-1");
  });

  it("normalizes case and surrounding whitespace", () => {
    const dedup = new ScanDeduplicator();
    dedup.register("repo-a", SHA, "scan-1", 1_000);

    expect(
      dedup.register("repo-a", `  ${SHA.toUpperCase()}  `, "scan-2", 1_100),
    ).toEqual({ status: "duplicate", existingScanId: "scan-1" });
  });

  it("scopes deduplication per repository", () => {
    const dedup = new ScanDeduplicator();
    dedup.register("repo-a", SHA, "scan-a", 1_000);

    // Same SHA, different repository: not a duplicate.
    expect(dedup.register("repo-b", SHA, "scan-b", 1_000)).toEqual({
      status: "new",
      scanId: "scan-b",
    });
    expect(dedup.lookup("repo-a", SHA, 1_000)).toBe("scan-a");
    expect(dedup.lookup("repo-b", SHA, 1_000)).toBe("scan-b");
  });

  it("keeps an entry just inside the TTL and expires it at the boundary", () => {
    const dedup = new ScanDeduplicator(1_000);
    dedup.register("repo-a", SHA, "scan-1", 10_000);

    expect(dedup.register("repo-a", SHA, "scan-2", 10_999)).toEqual({
      status: "duplicate",
      existingScanId: "scan-1",
    });
    // Exactly at createdAt + ttlMs the entry is expired.
    expect(dedup.register("repo-a", SHA, "scan-3", 11_000)).toEqual({
      status: "new",
      scanId: "scan-3",
    });
  });

  it("drops expired entries from the live count", () => {
    const dedup = new ScanDeduplicator(1_000);
    dedup.register("repo-a", "abcdef1", "scan-1", 1_000);
    dedup.register("repo-b", "abcdef2", "scan-2", 1_000);

    expect(dedup.size(1_500)).toBe(2);
    expect(dedup.size(2_000)).toBe(0);
  });

  it("allows re-registration after invalidation", () => {
    const dedup = new ScanDeduplicator();
    dedup.register("repo-a", SHA, "scan-1", 1_000);

    expect(dedup.invalidate("repo-a", SHA)).toBe(true);
    expect(dedup.invalidate("repo-a", SHA)).toBe(false);
    expect(dedup.register("repo-a", SHA, "scan-2", 1_100)).toEqual({
      status: "new",
      scanId: "scan-2",
    });
  });

  it("rejects malformed commit SHAs", () => {
    const dedup = new ScanDeduplicator();
    for (const bad of ["", "   ", "abc123", "zzzzzzz", "g".repeat(40)]) {
      expect(() => dedup.register("repo-a", bad, "scan-1")).toThrow(TypeError);
    }
  });

  it("rejects empty repository and scan ids", () => {
    const dedup = new ScanDeduplicator();
    expect(() => dedup.register("", SHA, "scan-1")).toThrow(TypeError);
    expect(() => dedup.register("repo-a", SHA, "  ")).toThrow(TypeError);
  });

  it("rejects a non-positive TTL", () => {
    expect(() => new ScanDeduplicator(0)).toThrow(RangeError);
    expect(() => new ScanDeduplicator(-5)).toThrow(RangeError);
  });
});
