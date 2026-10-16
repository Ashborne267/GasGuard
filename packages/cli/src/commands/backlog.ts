import { Command } from "commander";
import fs from "fs-extra";
import path from "path";
import {
  createRemediationBacklog,
  exportRemediationBacklog,
  type BacklogFormat,
} from "../reporting/backlog-exporter";

const formats: readonly BacklogFormat[] = ["json", "csv", "markdown"];

export async function runBacklogExport(
  reportPath: string,
  options: { format?: string; output?: string } = {},
): Promise<string> {
  const format = options.format ?? "csv";
  if (!formats.includes(format as BacklogFormat)) {
    throw new Error(
      `Unsupported format "${format}". Expected: ${formats.join(", ")}.`,
    );
  }
  const report = await fs.readJson(reportPath);
  const content = exportRemediationBacklog(
    createRemediationBacklog(report),
    format as BacklogFormat,
  );
  if (options.output) {
    await fs.ensureDir(path.dirname(path.resolve(options.output)));
    await fs.writeFile(options.output, content, "utf8");
  }
  return content;
}

export const backlogCommand = new Command("backlog")
  .description(
    "Export an actionable remediation backlog from a JSON scan report",
  )
  .argument("<report>", "Path to a GasGuard JSON scan report")
  .option(
    "-f, --format <format>",
    "Export format: json, csv, or markdown",
    "csv",
  )
  .option(
    "-o, --output <file>",
    "Write the backlog to a file instead of stdout",
  )
  .action(
    async (
      reportPath: string,
      options: { format?: string; output?: string },
    ) => {
      try {
        const content = await runBacklogExport(reportPath, options);
        if (!options.output) {
          process.stdout.write(content);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `Unable to export remediation backlog: ${message}\n`,
        );
        process.exitCode = 1;
      }
    },
  );
