import { ScanRetentionPolicy } from "./scan-retention";

const DAY = 24 * 60 * 60 * 1000;

describe("ScanRetentionPolicy", () => {
  const policy = new ScanRetentionPolicy([
    { tier: "free", retentionMs: 7 * DAY },
    { tier: "pro", retentionMs: 30 * DAY },
  ]);

  it("resolves the window for a known tier", () => {
    expect(policy.retentionMsFor("free")).toBe(7 * DAY);
    expect(policy.retentionMsFor("pro")).toBe(30 * DAY);
    expect(policy.tiers()).toEqual(["free", "pro"]);
  });

  it("computes the expiry timestamp", () => {
    expect(policy.expiresAt(1_000, "free")).toBe(1_000 + 7 * DAY);
  });

  it("keeps a scan just inside the window and expires it at the boundary", () => {
    const created = 1_000;
    const boundary = created + 7 * DAY;

    expect(policy.isExpired(created, "free", boundary - 1)).toBe(false);
    expect(policy.isExpired(created, "free", boundary)).toBe(true);
  });

  it("uses the configured default tier when none is supplied", () => {
    const withDefault = new ScanRetentionPolicy(
      [
        { tier: "free", retentionMs: DAY },
        { tier: "pro", retentionMs: 2 * DAY },
      ],
      "pro",
    );
    expect(withDefault.retentionMsFor()).toBe(2 * DAY);
  });

  it("selects only the scans that have expired, in input order", () => {
    const scans = [
      { scanId: "old-free", tier: "free", createdAt: 0 },
      { scanId: "fresh-free", tier: "free", createdAt: 6 * DAY },
      { scanId: "old-pro", tier: "pro", createdAt: 0 },
      { scanId: "fresh-pro", tier: "pro", createdAt: 29 * DAY },
    ];

    expect(policy.selectExpired(scans, 7 * DAY)).toEqual(["old-free"]);
    expect(policy.selectExpired(scans, 30 * DAY)).toEqual([
      "old-free",
      "fresh-free",
      "old-pro",
    ]);
  });

  it("returns no scans when nothing is eligible", () => {
    expect(
      policy.selectExpired([{ scanId: "s", tier: "pro", createdAt: 0 }], 1_000),
    ).toEqual([]);
  });

  it("rejects an unknown tier instead of guessing", () => {
    expect(() => policy.retentionMsFor("enterprise")).toThrow(RangeError);
    expect(() =>
      policy.selectExpired([{ scanId: "s", tier: "gone", createdAt: 0 }], 1e12),
    ).toThrow(RangeError);
  });

  it("requires a default tier to be known", () => {
    expect(
      () => new ScanRetentionPolicy([{ tier: "free", retentionMs: DAY }], "pro"),
    ).toThrow(RangeError);
    expect(() => policy.retentionMsFor()).toThrow(RangeError);
  });

  it("rejects malformed policies", () => {
    expect(() => new ScanRetentionPolicy([])).toThrow(RangeError);
    expect(
      () => new ScanRetentionPolicy([{ tier: "free", retentionMs: 0 }]),
    ).toThrow(RangeError);
    expect(
      () => new ScanRetentionPolicy([{ tier: "  ", retentionMs: DAY }]),
    ).toThrow(TypeError);
    expect(
      () =>
        new ScanRetentionPolicy([
          { tier: "free", retentionMs: DAY },
          { tier: "free", retentionMs: 2 * DAY },
        ]),
    ).toThrow(RangeError);
  });
});
