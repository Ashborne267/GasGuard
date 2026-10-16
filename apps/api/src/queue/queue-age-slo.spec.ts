import { QueueAgeSlo } from "./queue-age-slo";

describe("QueueAgeSlo", () => {
  const slo = new QueueAgeSlo({ warningMs: 60_000, breachMs: 300_000 });

  it("classifies a young queue as healthy", () => {
    expect(slo.evaluate(1_000, 1_000 + 30_000)).toEqual({
      status: "healthy",
      ageMs: 30_000,
    });
  });

  it("classifies at the warning boundary", () => {
    expect(slo.evaluate(0, 59_999).status).toBe("healthy");
    expect(slo.evaluate(0, 60_000)).toEqual({
      status: "warning",
      ageMs: 60_000,
    });
  });

  it("classifies at the breach boundary and reports overrun", () => {
    expect(slo.evaluate(0, 299_999).status).toBe("warning");
    expect(slo.evaluate(0, 300_000)).toEqual({
      status: "breached",
      ageMs: 300_000,
      breachOverrunMs: 0,
    });
    expect(slo.evaluate(0, 305_000).breachOverrunMs).toBe(5_000);
  });

  it("clamps a future enqueue timestamp to a zero age", () => {
    expect(slo.evaluate(10_000, 5_000)).toEqual({
      status: "healthy",
      ageMs: 0,
    });
  });

  it("summarizes a batch and reports the worst status", () => {
    const summary = slo.evaluateAges([1_000, 70_000, 400_000, 20_000]);
    expect(summary).toEqual({
      status: "breached",
      worstAgeMs: 400_000,
      healthy: 2,
      warning: 1,
      breached: 1,
    });
  });

  it("treats an empty batch as healthy", () => {
    expect(slo.evaluateAges([])).toEqual({
      status: "healthy",
      worstAgeMs: 0,
      healthy: 0,
      warning: 0,
      breached: 0,
    });
    expect(slo.compliance([])).toBe(1);
  });

  it("computes the fraction of ages within the SLO", () => {
    expect(slo.compliance([0, 10_000, 70_000, 400_000])).toBe(0.5);
    expect(slo.compliance([0, 10_000])).toBe(1);
    expect(slo.compliance([400_000])).toBe(0);
  });

  it("rejects invalid thresholds", () => {
    expect(() => new QueueAgeSlo({ warningMs: 0, breachMs: 10 })).toThrow(
      RangeError,
    );
    expect(() => new QueueAgeSlo({ warningMs: 100, breachMs: 50 })).toThrow(
      RangeError,
    );
    // Equal thresholds are allowed: warning and breach coincide.
    expect(
      new QueueAgeSlo({ warningMs: 100, breachMs: 100 }).evaluate(0, 100),
    ).toMatchObject({ status: "breached" });
  });

  it("rejects non-finite input", () => {
    expect(() => slo.evaluate(NaN, 0)).toThrow(TypeError);
    expect(() => slo.evaluate(0, Infinity)).toThrow(TypeError);
    expect(() => slo.evaluateAges([10, NaN])).toThrow(TypeError);
    expect(() => slo.compliance([10, NaN])).toThrow(TypeError);
  });
});
