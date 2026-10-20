import * as fs from "fs-extra";
import * as path from "path";
import { parse } from "yaml";

export type PipelineTier = "pr_ephemeral" | "scheduled_scan" | "release_artifact" | "compliance_archive";

export interface RetentionPolicyBoundary {
  minDays: number;
  maxDays: number;
  recommendedDays: number;
}

export const RETENTION_TIER_BOUNDARIES: Record<PipelineTier, RetentionPolicyBoundary> = {
  pr_ephemeral: { minDays: 1, maxDays: 14, recommendedDays: 7 },
  scheduled_scan: { minDays: 7, maxDays: 30, recommendedDays: 30 },
  release_artifact: { minDays: 30, maxDays: 90, recommendedDays: 90 },
  compliance_archive: { minDays: 90, maxDays: 365, recommendedDays: 180 },
};

export interface WorkflowArtifactFinding {
  filePath: string;
  jobName: string;
  stepName?: string;
  artifactName?: string;
  retentionDays?: number;
  tier: PipelineTier;
  isValid: boolean;
  message: string;
}

export interface ValidationSummary {
  totalWorkflowsChecked: number;
  totalUploadSteps: number;
  compliantSteps: number;
  violationsCount: number;
  findings: WorkflowArtifactFinding[];
}

export class ArtifactRetentionValidator {
  /**
   * Infers pipeline tier from workflow file name and content.
   */
  public inferTier(filePath: string, workflowContent: string): PipelineTier {
    const baseName = path.basename(filePath).toLowerCase();
    if (baseName.startsWith("release-") || baseName.includes("release")) {
      return "release_artifact";
    }
    if (baseName.includes("scheduled") || baseName.includes("nightly")) {
      return "scheduled_scan";
    }
    if (baseName.includes("compliance") || baseName.includes("audit")) {
      return "compliance_archive";
    }
    if (baseName === "ci.yml" || baseName.startsWith("ci-") || baseName.includes("pull-request")) {
      return "pr_ephemeral";
    }
    return "scheduled_scan"; // default for gasguard-scan, etc.
  }

  /**
   * Validates retention days against tier constraints.
   */
  public validateRetentionDays(
    retentionDays: number | undefined,
    tier: PipelineTier,
  ): { isValid: boolean; message: string } {
    const boundaries = RETENTION_TIER_BOUNDARIES[tier];

    if (retentionDays === undefined || retentionDays === null) {
      return {
        isValid: false,
        message: `Missing 'retention-days'. For tier '${tier}', explicit retention between ${boundaries.minDays} and ${boundaries.maxDays} days is required (recommended: ${boundaries.recommendedDays} days).`,
      };
    }

    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      return {
        isValid: false,
        message: `Invalid 'retention-days': ${retentionDays}. Must be a positive integer.`,
      };
    }

    if (retentionDays < boundaries.minDays) {
      return {
        isValid: false,
        message: `'retention-days' ${retentionDays} is below minimum allowed (${boundaries.minDays} days) for tier '${tier}'.`,
      };
    }

    if (retentionDays > boundaries.maxDays) {
      return {
        isValid: false,
        message: `'retention-days' ${retentionDays} exceeds maximum allowed (${boundaries.maxDays} days) for tier '${tier}'.`,
      };
    }

    return {
      isValid: true,
      message: `Compliant with '${tier}' policy (configured: ${retentionDays} days, recommended: ${boundaries.recommendedDays} days).`,
    };
  }

  /**
   * Validates a parsed GitHub Actions workflow structure.
   */
  public validateWorkflowContent(
    filePath: string,
    content: string,
  ): WorkflowArtifactFinding[] {
    const findings: WorkflowArtifactFinding[] = [];
    const tier = this.inferTier(filePath, content);

    let parsed: any;
    try {
      parsed = parse(content);
    } catch (err) {
      findings.push({
        filePath,
        jobName: "unknown",
        tier,
        isValid: false,
        message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
      });
      return findings;
    }

    const jobs = parsed?.jobs;
    if (!jobs || typeof jobs !== "object") {
      return findings;
    }

    for (const [jobName, job] of Object.entries<any>(jobs)) {
      const steps = job?.steps;
      if (!Array.isArray(steps)) continue;

      for (const step of steps) {
        if (
          typeof step?.uses === "string" &&
          step.uses.startsWith("actions/upload-artifact")
        ) {
          const withParams = step.with ?? {};
          let rawRetention = withParams["retention-days"];
          let retentionDays: number | undefined;

          // If parameterized in reusable workflow, resolve default from workflow_call inputs
          if (
            typeof rawRetention === "string" &&
            rawRetention.trim().startsWith("${{") &&
            rawRetention.includes("inputs.")
          ) {
            const inputMatch = rawRetention.match(/inputs\.([a-zA-Z0-9_-]+)/);
            if (inputMatch) {
              const inputKey = inputMatch[1];
              const defaultVal =
                parsed?.on?.workflow_call?.inputs?.[inputKey]?.default;
              if (defaultVal !== undefined) {
                rawRetention = defaultVal;
              }
            }
          }

          if (rawRetention !== undefined && rawRetention !== null) {
            retentionDays = Number(rawRetention);
          }

          const artifactName = withParams.name;
          const check = this.validateRetentionDays(retentionDays, tier);

          findings.push({
            filePath,
            jobName,
            stepName: step.name,
            artifactName,
            retentionDays,
            tier,
            isValid: check.isValid,
            message: check.message,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Validates all workflows in a given directory.
   */
  public async validateWorkflowsDirectory(
    directoryPath: string,
  ): Promise<ValidationSummary> {
    const findings: WorkflowArtifactFinding[] = [];
    let totalWorkflowsChecked = 0;

    const files = await fs.readdir(directoryPath);
    const yamlFiles = files.filter((f) => /\.ya?ml$/i.test(f));

    for (const file of yamlFiles) {
      const fullPath = path.join(directoryPath, file);
      const content = await fs.readFile(fullPath, "utf8");
      totalWorkflowsChecked++;
      const wfFindings = this.validateWorkflowContent(fullPath, content);
      findings.push(...wfFindings);
    }

    const compliantSteps = findings.filter((f) => f.isValid).length;
    const violationsCount = findings.filter((f) => !f.isValid).length;

    return {
      totalWorkflowsChecked,
      totalUploadSteps: findings.length,
      compliantSteps,
      violationsCount,
      findings,
    };
  }

  /**
   * Validates GitLab CI artifacts:expire_in string syntax.
   */
  public parseGitLabExpireIn(expireIn: string): number {
    const match = expireIn.trim().match(/^(\d+)\s*(days?|d|weeks?|w|months?|m|hours?|h)$/i);
    if (!match) {
      throw new Error(`Unrecognized GitLab expire_in format: "${expireIn}"`);
    }
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (unit.startsWith("d")) return val;
    if (unit.startsWith("w")) return val * 7;
    if (unit.startsWith("m")) return val * 30;
    if (unit.startsWith("h")) return Math.ceil(val / 24);
    return val;
  }
}
