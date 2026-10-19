import { loadGoldenSnapshotConfig } from "./golden-snapshot-config";
import { GoldenSnapshotError } from "./golden-snapshot-types";

describe("GoldenSnapshotConfig", () => {
  it("loads default config when env is empty", () => {
    const config = loadGoldenSnapshotConfig({});
    expect(config.enabled).toBe(true);
    expect(config.enforceMatching).toBe(false);
    expect(config.autoUpdate).toBe(false);
    expect(config.maxDiffCount).toBe(500);
    expect(config.maxPayloadSizeBytes).toBe(10 * 1024 * 1024);
  });

  it("parses valid custom env variables", () => {
    const config = loadGoldenSnapshotConfig({
      GOLDEN_SNAPSHOT_ENABLED: "false",
      GOLDEN_SNAPSHOT_STORAGE_DIR: "/tmp/snapshots",
      GOLDEN_SNAPSHOT_ENFORCE_MATCHING: "true",
      GOLDEN_SNAPSHOT_AUTO_UPDATE: "1",
      GOLDEN_SNAPSHOT_MAX_DIFF_COUNT: "100",
      GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE: "2048",
    });
    expect(config.enabled).toBe(false);
    expect(config.storageDir).toBe("/tmp/snapshots");
    expect(config.enforceMatching).toBe(true);
    expect(config.autoUpdate).toBe(true);
    expect(config.maxDiffCount).toBe(100);
    expect(config.maxPayloadSizeBytes).toBe(2048);
  });

  it("throws on invalid maxDiffCount", () => {
    expect(() =>
      loadGoldenSnapshotConfig({
        GOLDEN_SNAPSHOT_MAX_DIFF_COUNT: "not-a-number",
      }),
    ).toThrow(GoldenSnapshotError);

    expect(() =>
      loadGoldenSnapshotConfig({
        GOLDEN_SNAPSHOT_MAX_DIFF_COUNT: "-5",
      }),
    ).toThrow(GoldenSnapshotError);
  });

  it("throws on invalid maxPayloadSize", () => {
    expect(() =>
      loadGoldenSnapshotConfig({
        GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE: "0",
      }),
    ).toThrow(GoldenSnapshotError);
  });
});
