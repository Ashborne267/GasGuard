import fs from "fs-extra";
import path from "path";
import { parse } from "yaml";

describe("Reusable CI Workflow Templates (#1071)", () => {
  const workflowsDir = path.join(process.cwd(), ".github", "workflows");
  const templatesDir = path.join(process.cwd(), ".github", "workflow-templates");

  describe("Reusable GasGuard Scan Workflow", () => {
    const scanWorkflowPath = path.join(
      workflowsDir,
      "reusable-gasguard-scan.yml",
    );

    it("exists and is valid YAML", async () => {
      expect(await fs.pathExists(scanWorkflowPath)).toBe(true);
      const content = await fs.readFile(scanWorkflowPath, "utf8");
      const parsed = parse(content);
      expect(parsed).toBeDefined();
      expect(parsed.name).toContain("Reusable GasGuard Scan");
    });

    it("declares workflow_call trigger with required inputs", async () => {
      const content = await fs.readFile(scanWorkflowPath, "utf8");
      const parsed = parse(content);
      const call = parsed.on?.workflow_call;
      expect(call).toBeDefined();
      expect(call.inputs).toBeDefined();
      expect(call.inputs["contracts-path"]).toBeDefined();
      expect(call.inputs["report-format"]).toBeDefined();
      expect(call.inputs["fail-on-severity"]).toBeDefined();
      expect(call.inputs["retention-days"]).toBeDefined();
      expect(call.inputs["retention-days"].default).toBe(30);
    });

    it("declares outputs and least-privilege permissions", async () => {
      const content = await fs.readFile(scanWorkflowPath, "utf8");
      const parsed = parse(content);
      expect(parsed.permissions?.contents).toBe("read");
      expect(parsed.on.workflow_call.outputs["report-path"]).toBeDefined();
      expect(parsed.on.workflow_call.outputs["findings-count"]).toBeDefined();
    });
  });

  describe("Reusable Quality Gate Workflow", () => {
    const gateWorkflowPath = path.join(
      workflowsDir,
      "reusable-quality-gate.yml",
    );

    it("exists and defines workflow_call trigger with test inputs", async () => {
      expect(await fs.pathExists(gateWorkflowPath)).toBe(true);
      const content = await fs.readFile(gateWorkflowPath, "utf8");
      const parsed = parse(content);
      expect(parsed.on?.workflow_call).toBeDefined();
      expect(parsed.on.workflow_call.inputs["run-tests"]).toBeDefined();
      expect(parsed.on.workflow_call.inputs["retention-days"].default).toBe(14);
    });
  });

  describe("Starter Workflow Templates", () => {
    const starterYmlPath = path.join(
      templatesDir,
      "gasguard-contract-scan.yml",
    );
    const starterJsonPath = path.join(
      templatesDir,
      "gasguard-contract-scan.properties.json",
    );

    it("defines valid starter workflow referring to reusable scan", async () => {
      expect(await fs.pathExists(starterYmlPath)).toBe(true);
      const content = await fs.readFile(starterYmlPath, "utf8");
      const parsed = parse(content);
      expect(parsed.name).toBe("GasGuard Smart Contract Scan");
      expect(parsed.jobs?.gasguard?.uses).toContain("reusable-gasguard-scan.yml");
    });

    it("defines valid properties metadata JSON", async () => {
      expect(await fs.pathExists(starterJsonPath)).toBe(true);
      const json = await fs.readJson(starterJsonPath);
      expect(json.name).toBeDefined();
      expect(json.description).toBeDefined();
      expect(Array.isArray(json.categories)).toBe(true);
      expect(Array.isArray(json.filePatterns)).toBe(true);
    });
  });
});
