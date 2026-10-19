import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  InMemoryGoldenSnapshotStore,
  FileGoldenSnapshotStore,
} from "./golden-snapshot-store";
import {
  createSnapshotManifest,
} from "./golden-snapshot-evaluator";
import * as realisticFixture from "./__fixtures__/realistic-repo-fixture.json";
import { LanguageGoldenOutput } from "./golden-snapshot-types";

describe("GoldenSnapshotStore", () => {
  describe("InMemoryGoldenSnapshotStore", () => {
    it("saves and retrieves snapshots across tenant boundaries", async () => {
      const store = new InMemoryGoldenSnapshotStore();
      const manifest = createSnapshotManifest({
        tenantId: "tenant-a",
        repositoryId: "repo-1",
        commitHash: "hash-1",
        rulePackVersion: "1.0.0",
        languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
      });

      await store.saveSnapshot(manifest);

      const found = await store.getSnapshot("tenant-a", "repo-1", "hash-1", "1.0.0");
      expect(found).toBeDefined();
      expect(found?.snapshotId).toBe(manifest.snapshotId);

      // Verify tenant isolation
      const otherTenant = await store.getSnapshot("tenant-b", "repo-1", "hash-1", "1.0.0");
      expect(otherTenant).toBeUndefined();
    });

    it("saves and retrieves scan pins idempotently", async () => {
      const store = new InMemoryGoldenSnapshotStore();
      const pin = {
        tenantId: "tenant-a",
        scanId: "scan-123",
        repositoryId: "repo-1",
        commitHash: "hash-1",
        rulePackVersion: "1.0.0",
        snapshotId: "snapshot-123",
        pinnedAt: 1000,
        fingerprint: "abc",
      };

      const saved = await store.saveScanPin(pin);
      expect(saved).toEqual(pin);

      const savedAgain = await store.saveScanPin({
        ...pin,
        snapshotId: "different-id",
      });
      // Should preserve write-once behavior
      expect(savedAgain.snapshotId).toBe("snapshot-123");

      const fetched = await store.getScanPin("tenant-a", "scan-123");
      expect(fetched?.snapshotId).toBe("snapshot-123");
    });
  });

  describe("FileGoldenSnapshotStore", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-snapshot-store-test-"));
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it("saves and retrieves snapshots from disk with directory isolation", async () => {
      const store = new FileGoldenSnapshotStore(tmpDir);
      const manifest = createSnapshotManifest({
        tenantId: "tenant-a",
        repositoryId: "repo-1",
        commitHash: "hash-1",
        rulePackVersion: "1.0.0",
        languageOutputs: realisticFixture.languageOutputs as Record<string, LanguageGoldenOutput>,
      });

      await store.saveSnapshot(manifest);

      const found = await store.getSnapshot("tenant-a", "repo-1", "hash-1", "1.0.0");
      expect(found).toBeDefined();
      expect(found?.snapshotId).toBe(manifest.snapshotId);

      const byId = await store.getSnapshotById("tenant-a", manifest.snapshotId);
      expect(byId?.fingerprint).toBe(manifest.fingerprint);

      // Tenant isolation on filesystem
      const otherTenant = await store.getSnapshot("tenant-b", "repo-1", "hash-1", "1.0.0");
      expect(otherTenant).toBeUndefined();
    });

    it("persists scan pins and verifications on disk", async () => {
      const store = new FileGoldenSnapshotStore(tmpDir);
      const pin = {
        tenantId: "tenant-a",
        scanId: "scan-999",
        repositoryId: "repo-1",
        commitHash: "hash-1",
        rulePackVersion: "1.0.0",
        snapshotId: "snap-999",
        pinnedAt: 2000,
        fingerprint: "fp-999",
      };

      await store.saveScanPin(pin);
      const retrieved = await store.getScanPin("tenant-a", "scan-999");
      expect(retrieved?.snapshotId).toBe("snap-999");

      await store.saveVerification({
        status: "matched",
        matched: true,
        tenantId: "tenant-a",
        repositoryId: "repo-1",
        commitHash: "hash-1",
        rulePackVersion: "1.0.0",
        expectedFingerprint: "fp",
        actualFingerprint: "fp",
        languageResults: {},
        totalDifferences: 0,
        verifiedAt: 3000,
      });

      const verif = await store.getLatestVerification("tenant-a", "repo-1");
      expect(verif?.status).toBe("matched");
    });
  });
});
