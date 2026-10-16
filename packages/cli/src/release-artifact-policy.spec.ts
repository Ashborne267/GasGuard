import fs from "fs";
import path from "path";
import { parse } from "yaml";

interface Workflow {
  jobs?: Record<
    string,
    { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }
  >;
}

describe("release artifact retention policy", () => {
  it("sets 90-day retention for every uploaded release workflow artifact", () => {
    const workflowsDirectory = path.join(process.cwd(), ".github", "workflows");
    const releaseWorkflows = fs
      .readdirSync(workflowsDirectory)
      .filter((file) => /^release-.*\.ya?ml$/.test(file));
    const uploads = releaseWorkflows.flatMap((file) => {
      const workflow = parse(
        fs.readFileSync(path.join(workflowsDirectory, file), "utf8"),
      ) as Workflow;
      return Object.values(workflow.jobs ?? {}).flatMap((job) =>
        (job.steps ?? []).filter((step) =>
          step.uses?.startsWith("actions/upload-artifact@"),
        ),
      );
    });

    expect(releaseWorkflows.length).toBeGreaterThan(0);
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((step) => step.with?.["retention-days"] === 90)).toBe(
      true,
    );
  });
});
