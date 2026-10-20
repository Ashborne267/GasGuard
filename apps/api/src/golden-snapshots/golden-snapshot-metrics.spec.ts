import {
  GoldenSnapshotMetrics,
  sanitizeLogContext,
} from "./golden-snapshot-metrics";

describe("GoldenSnapshotMetrics and Logging", () => {
  it("records metrics accurately", () => {
    const metrics = new GoldenSnapshotMetrics();
    metrics.recordSnapshotCreated(3);

    metrics.recordVerification("matched", {
      solidity: { matched: true, findingDiffs: [] },
    });
    metrics.recordVerification("mismatched", {
      solidity: { matched: false, findingDiffs: [{ type: "added" }] },
    });
    metrics.recordVerification("missing", {});

    const counters = metrics.getCounters();
    expect(counters.snapshotsCreated).toBe(1);
    expect(counters.verificationsTotal).toBe(3);
    expect(counters.verificationsMatched).toBe(1);
    expect(counters.verificationsMismatched).toBe(1);
    expect(counters.verificationsMissing).toBe(1);
    expect(counters.languageDifferencesTotal["solidity"]).toBe(1);
  });

  it("sanitizes secrets, tokens, passwords, and sensitive keys from logs", () => {
    const rawContext = {
      tenantId: "tenant-123",
      repositoryId: "my-repo",
      apiKey: "secret-key-12345",
      userToken: "ghp_xxxxxxxxxxxx",
      nested: {
        password: "supersecretpassword",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        normalField: "safe value",
      },
    };

    const sanitized = sanitizeLogContext(rawContext) as any;
    expect(sanitized.tenantId).toBe("tenant-123");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.userToken).toBe("[REDACTED]");
    expect(sanitized.nested.password).toBe("[REDACTED]");
    expect(sanitized.nested.privateKey).toBe("[REDACTED]");
    expect(sanitized.nested.normalField).toBe("safe value");
  });
});
