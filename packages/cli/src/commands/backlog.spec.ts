import fs from "fs-extra";
import os from "os";
import path from "path";
import { runBacklogExport } from "./backlog";

describe("backlog command", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "gasguard-backlog-"));
    await fs.writeJson(path.join(directory, "scan.json"), {
      findings: [
        {
          file: "contracts/A.sol",
          line: 12,
          ruleId: "SOL-001",
          severity: "high",
          message: "Cache storage read",
          suggestion: "Load once before the loop",
        },
      ],
    });
  });

  afterEach(async () => {
    await fs.remove(directory);
  });

  it("exports a scan report to a requested destination", async () => {
    const outputPath = path.join(directory, "exports", "backlog.csv");
    const output = await runBacklogExport(path.join(directory, "scan.json"), {
      output: outputPath,
    });
    expect(output).toContain("Cache storage read");
    await expect(fs.readFile(outputPath, "utf8")).resolves.toContain(
      "Load once before the loop",
    );
  });

  it("rejects missing reports and unsupported formats", async () => {
    await expect(
      runBacklogExport(path.join(directory, "missing.json")),
    ).rejects.toThrow();
    await expect(
      runBacklogExport(path.join(directory, "scan.json"), { format: "xml" }),
    ).rejects.toThrow("Unsupported format");
  });
});
