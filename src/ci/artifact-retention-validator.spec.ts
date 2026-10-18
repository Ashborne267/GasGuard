import path from "path";
import {
  ArtifactRetentionValidator,
  RETENTION_TIER_BOUNDARIES,
} from "./artifact-retention-validator";

describe("ArtifactRetentionValidator (#1086)", () => {
  let validator: ArtifactRetentionValidator;

  beforeEach(() => {
    validator = new ArtifactRetentionValidator();
  });

  describe("Tier Inference", () => {
    it("classifies release workflows as release_artifact tier", () => {
      expect(validator.inferTier(".github/workflows/release-cli.yml", "")).toBe(
        "release_artifact",
      );
      expect(validator.inferTier(".github/workflows/release-sbom.yml", "")).toBe(
        "release_artifact",
      );
    });

    it("classifies scheduled workflows as scheduled_scan tier", () => {
      expect(
        validator.inferTier(".github/workflows/scheduled-scan.yml", ""),
      ).toBe("scheduled_scan");
    });
  });

  describe("Retention Days Validation (Normal & Boundaries)", () => {
    it("approves recommended and boundary values for release_artifact tier", () => {
      const bounds = RETENTION_TIER_BOUNDARIES.release_artifact;
      expect(
        validator.validateRetentionDays(bounds.recommendedDays, "release_artifact")
          .isValid,
      ).toBe(true);
      expect(
        validator.validateRetentionDays(bounds.minDays, "release_artifact").isValid,
      ).toBe(true);
      expect(
        validator.validateRetentionDays(bounds.maxDays, "release_artifact").isValid,
      ).toBe(true);
    });

    it("rejects missing retention-days", () => {
      const res = validator.validateRetentionDays(undefined, "release_artifact");
      expect(res.isValid).toBe(false);
      expect(res.message).toContain("Missing 'retention-days'");
    });

    it("rejects non-positive numbers and floats", () => {
      expect(validator.validateRetentionDays(0, "scheduled_scan").isValid).toBe(
        false,
      );
      expect(
        validator.validateRetentionDays(-5, "scheduled_scan").isValid,
      ).toBe(false);
      expect(
        validator.validateRetentionDays(12.5, "scheduled_scan").isValid,
      ).toBe(false);
    });

    it("rejects retention below minimum or above maximum boundaries", () => {
      // release_artifact: min 30, max 90
      expect(
        validator.validateRetentionDays(29, "release_artifact").isValid,
      ).toBe(false);
      expect(
        validator.validateRetentionDays(91, "release_artifact").isValid,
      ).toBe(false);

      // pr_ephemeral: min 1, max 14
      expect(validator.validateRetentionDays(15, "pr_ephemeral").isValid).toBe(
        false,
      );
    });
  });

  describe("Workflow Content Validation", () => {
    it("extracts upload-artifact steps and validates them", () => {
      const yaml = `
name: Sample
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: sample-report
          retention-days: 30
      - uses: actions/upload-artifact@v4
        with:
          name: bad-report
`;
      const findings = validator.validateWorkflowContent(
        "sample-scan.yml",
        yaml,
      );
      expect(findings).toHaveLength(2);
      expect(findings[0].isValid).toBe(true);
      expect(findings[0].retentionDays).toBe(30);
      expect(findings[1].isValid).toBe(false);
      expect(findings[1].message).toContain("Missing 'retention-days'");
    });

    it("gracefully reports YAML syntax errors", () => {
      const badYaml = "jobs: [unclosed array";
      const findings = validator.validateWorkflowContent("corrupt.yml", badYaml);
      expect(findings).toHaveLength(1);
      expect(findings[0].isValid).toBe(false);
      expect(findings[0].message).toContain("Failed to parse YAML");
    });
  });

  describe("GitLab expire_in Parser", () => {
    it("parses various units correctly", () => {
      expect(validator.parseGitLabExpireIn("7 days")).toBe(7);
      expect(validator.parseGitLabExpireIn("2 weeks")).toBe(14);
      expect(validator.parseGitLabExpireIn("1 month")).toBe(30);
      expect(validator.parseGitLabExpireIn("48 hours")).toBe(2);
      expect(validator.parseGitLabExpireIn("30d")).toBe(30);
    });

    it("throws on invalid formats", () => {
      expect(() => validator.parseGitLabExpireIn("forever")).toThrow(
        "Unrecognized GitLab expire_in format",
      );
    });
  });

  describe("Live Workflow Directory Verification", () => {
    it("validates repository .github/workflows directory without errors", async () => {
      const workflowsDir = path.join(process.cwd(), ".github", "workflows");
      const summary = await validator.validateWorkflowsDirectory(workflowsDir);
      expect(summary.totalWorkflowsChecked).toBeGreaterThan(0);
      expect(summary.totalUploadSteps).toBeGreaterThan(0);
      // All existing workflows with upload-artifact declare compliant retention-days
      expect(summary.violationsCount).toBe(0);
    });
  });
});
