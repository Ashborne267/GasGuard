import fs from "fs-extra";
import os from "os";
import path from "path";
import { runComparison } from "./compare";

describe("compare command", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "gasguard-compare-"));
    await fs.writeJson(path.join(directory, "baseline.json"), {
      metadata: { timestamp: "2026-10-01T00:00:00.000Z" },
      findings: [
        {
          file: "contracts/A.sol",
          line: 1,
          ruleId: "SOL-001",
          severity: "high",
          message: "Repeated read",
        },
      ],
    });
    await fs.writeJson(path.join(directory, "current.json"), {
      metadata: { timestamp: "2026-10-15T00:00:00.000Z" },
      findings: [],
    });
  });

  afterEach(async () => {
    await fs.remove(directory);
  });

  it("reads scan reports and writes a JSON comparison to the requested path", async () => {
    const outputPath = path.join(directory, "reports", "comparison.json");
    const output = await runComparison(
      path.join(directory, "baseline.json"),
      path.join(directory, "current.json"),
      { format: "json", output: outputPath },
    );

    expect(JSON.parse(output).summary).toMatchObject({
      baselineFindings: 1,
      currentFindings: 0,
      added: 0,
      resolved: 1,
      netChange: -1,
    });
    await expect(fs.readJson(outputPath)).resolves.toMatchObject({
      summary: { resolved: 1 },
    });
  });

  it("rejects unsupported formats and invalid scan reports", async () => {
    await expect(
      runComparison("baseline.json", "current.json", { format: "csv" }),
    ).rejects.toThrow("Unsupported format");
    const invalidPath = path.join(directory, "invalid.json");
    await fs.writeJson(invalidPath, { findings: [{}] });
    await expect(
      runComparison(invalidPath, path.join(directory, "current.json")),
    ).rejects.toThrow("invalid finding at index 0");
  });
});