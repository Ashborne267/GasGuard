import { ScanLeaseManager } from "./scan-lease";

describe("ScanLeaseManager", () => {
  it("grants a fresh lease with fencing token 1", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);

    const result = manager.acquire("scan-1", "worker-a");
    expect(result).toEqual({
      granted: true,
      lease: {
        scanId: "scan-1",
        owner: "worker-a",
        token: 1,
        acquiredAt: 1_000,
        expiresAt: 6_000,
      },
    });
  });

  it("refuses to grant a lease that is held by another live owner", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    manager.acquire("scan-1", "worker-a");

    expect(manager.acquire("scan-1", "worker-b")).toEqual({
      granted: false,
      heldBy: "worker-a",
      expiresAt: 6_000,
    });
  });

  it("keeps the lease live one tick before expiry and frees it at the boundary", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    manager.acquire("scan-1", "worker-a");

    now = 5_999;
    expect(manager.get("scan-1")?.owner).toBe("worker-a");
    expect(manager.acquire("scan-1", "worker-b").granted).toBe(false);

    now = 6_000;
    expect(manager.get("scan-1")).toBeUndefined();
    const takeover = manager.acquire("scan-1", "worker-b");
    expect(takeover.granted).toBe(true);
  });

  it("issues an increasing fencing token on takeover", () => {
    let now = 0;
    const manager = new ScanLeaseManager(1_000, () => now);
    manager.acquire("scan-1", "worker-a");

    now = 2_000;
    const takeover = manager.acquire("scan-1", "worker-b");
    expect(takeover.granted && takeover.lease.token).toBe(2);
  });

  it("renews only live leases with the matching owner and token", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    const first = manager.acquire("scan-1", "worker-a");
    expect(first.granted).toBe(true);
    const token = first.granted ? first.lease.token : 0;

    now = 4_000;
    expect(manager.renew("scan-1", "worker-a", token)).toBe(true);
    expect(manager.get("scan-1")?.expiresAt).toBe(9_000);

    // Wrong owner and stale token are both refused.
    expect(manager.renew("scan-1", "worker-b", token)).toBe(false);
    expect(manager.renew("scan-1", "worker-a", token + 1)).toBe(false);
    expect(manager.renew("missing", "worker-a", 1)).toBe(false);
  });

  it("refuses to renew an expired lease", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    const first = manager.acquire("scan-1", "worker-a");
    const token = first.granted ? first.lease.token : 0;

    now = 6_000;
    expect(manager.renew("scan-1", "worker-a", token)).toBe(false);
  });

  it("releases only with the matching owner and token", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    const first = manager.acquire("scan-1", "worker-a");
    const token = first.granted ? first.lease.token : 0;

    expect(manager.release("scan-1", "worker-b", token)).toBe(false);
    expect(manager.release("scan-1", "worker-a", token + 1)).toBe(false);
    expect(manager.release("scan-1", "worker-a", token)).toBe(true);
    expect(manager.get("scan-1")).toBeUndefined();
  });

  it("reclaims expired leases and reports them", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    manager.acquire("scan-1", "worker-a");
    manager.acquire("scan-2", "worker-a");

    now = 6_000;
    expect(manager.reclaimExpired().sort()).toEqual(["scan-1", "scan-2"]);
    expect(manager.activeCount()).toBe(0);
    expect(manager.reclaimExpired()).toEqual([]);
  });

  it("counts only live leases", () => {
    let now = 1_000;
    const manager = new ScanLeaseManager(5_000, () => now);
    manager.acquire("scan-1", "worker-a");

    now = 3_000;
    manager.acquire("scan-2", "worker-b");
    expect(manager.activeCount()).toBe(2);

    now = 6_000;
    expect(manager.activeCount()).toBe(1);
  });

  it("rejects invalid construction and empty identifiers", () => {
    expect(() => new ScanLeaseManager(0)).toThrow(RangeError);
    expect(() => new ScanLeaseManager(-1)).toThrow(RangeError);
    const manager = new ScanLeaseManager(1_000);
    expect(() => manager.acquire("", "worker-a")).toThrow(TypeError);
    expect(() => manager.acquire("scan-1", "  ")).toThrow(TypeError);
  });
});
