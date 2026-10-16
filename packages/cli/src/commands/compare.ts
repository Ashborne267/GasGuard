import { Command } from "commander";
import fs from "fs-extra";
import path from "path";
import {
  compareScanReports,
  formatComparisonText,
  parseScanReport,
} from "../reporting/comparison-reporter";

export interface CompareCommandOptions {
  format?: string;
  output?: string;
}

export async function runComparison(
  baselinePath: string,
  currentPath: string,
  options: CompareCommandOptions = {},
): Promise<string> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error('Unsupported format; expected "text" or "json".');
  }

  const [baselineContent, currentContent] = await Promise.all([
    fs.readJson(baselinePath),
    fs.readJson(currentPath),
  ]);
  const report = compareScanReports(
    parseScanReport(baselineContent, baselinePath),
    parseScanReport(currentContent, currentPath),
  );
  const output =
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatComparisonText(report);

  if (options.output) {
    await fs.ensureDir(path.dirname(path.resolve(options.output)));
    await fs.writeFile(options.output, output, "utf8");
  }
  return output;
}

export const compareCommand = new Command("compare")
  .description("Compare findings in two GasGuard JSON scan reports")
  .arguments("<baseline> <current>")
  .option("-f, --format <format>", "Output format (text or json)", "text")
  .option("-o, --output <file>", "Write the comparison report to a file")
  .action(async (baselinePath: string, currentPath: string, options: CompareCommandOptions) => {
    try {
      const output = await runComparison(baselinePath, currentPath, options);
      if (!options.output) {
        process.stdout.write(output);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Unable to compare reports: ${message}\n`);
      process.exitCode = 1;
    }
  });