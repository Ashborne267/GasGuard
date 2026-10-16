import { ScanCheckpointStore } from "./scan-checkpoint";

describe("ScanCheckpointStore", () => {
  it("stores and reads back a checkpoint", () => {
    const store = new ScanCheckpointStore();
    const saved = store.save("scan-1", "parse", 10, 100, 5_000);

    expect(saved).toEqual({
      scanId: "scan-1",
      stage: "parse",
      processed: 10,
      total: 100,
      updatedAt: 5_000,
    });
    expect(store.get("scan-1")).toEqual(saved);
  });

  it("returns a resume point that continues from the processed count", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "parse", 10, 100);

    expect(store.resumeFrom("scan-1")).toEqual({
      stage: "parse",
      nextIndex: 10,
      total: 100,
      complete: false,
    });
  });

  it("treats a stage as complete at the boundary", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "parse", 99, 100);
    expect(store.isComplete("scan-1")).toBe(false);

    store.save("scan-1", "parse", 100, 100);
    expect(store.resumeFrom("scan-1")?.complete).toBe(true);
    expect(store.isComplete("scan-1")).toBe(true);
  });

  it("treats a zero-total stage as a single completed unit", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "finalize", 0, 0);
    expect(store.isComplete("scan-1")).toBe(true);
  });

  it("allows forward progress but rejects backward progress in the same stage", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "parse", 50, 100);

    expect(store.save("scan-1", "parse", 60, 100).processed).toBe(60);
    expect(() => store.save("scan-1", "parse", 40, 100)).toThrow(RangeError);
    // Re-saving the same point is idempotent rather than an error.
    expect(store.save("scan-1", "parse", 60, 100).processed).toBe(60);
  });

  it("resets the counter when a new stage begins", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "parse", 100, 100);
    // A new stage starts its own progress from zero.
    expect(store.save("scan-1", "analyze", 0, 50).processed).toBe(0);
    expect(store.resumeFrom("scan-1")).toMatchObject({
      stage: "analyze",
      nextIndex: 0,
      complete: false,
    });
  });

  it("returns undefined for an unknown scan", () => {
    const store = new ScanCheckpointStore();
    expect(store.get("missing")).toBeUndefined();
    expect(store.resumeFrom("missing")).toBeUndefined();
    expect(store.isComplete("missing")).toBe(false);
  });

  it("clears a checkpoint", () => {
    const store = new ScanCheckpointStore();
    store.save("scan-1", "parse", 10, 100);
    expect(store.size()).toBe(1);

    expect(store.clear("scan-1")).toBe(true);
    expect(store.clear("scan-1")).toBe(false);
    expect(store.size()).toBe(0);
    expect(store.get("scan-1")).toBeUndefined();
  });

  it("rejects invalid counts and identifiers", () => {
    const store = new ScanCheckpointStore();
    expect(() => store.save("scan-1", "parse", 101, 100)).toThrow(RangeError);
    expect(() => store.save("scan-1", "parse", -1, 100)).toThrow(RangeError);
    expect(() => store.save("scan-1", "parse", 1.5, 100)).toThrow(RangeError);
    expect(() => store.save("scan-1", "parse", 1, -100)).toThrow(RangeError);
    expect(() => store.save("", "parse", 1, 100)).toThrow(TypeError);
    expect(() => store.save("scan-1", "   ", 1, 100)).toThrow(TypeError);
  });
});
