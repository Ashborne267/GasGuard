/**
 * Telemetry hooks for the Command Injection analyzer.
 */

export type CommandInjectionSkipReason =
  | "unsupported-file-type"
  | "declaration-file"
  | "file-too-large"
  | "binary-content"
  | "invalid-input"
  | "excluded-by-config";

export interface CommandInjectionFileAnalyzedEvent {
  file: string;
  durationMs: number;
  findingsByRule: Record<string, number>;
}

export interface CommandInjectionFileSkippedEvent {
  file: string;
  reason: CommandInjectionSkipReason;
}

export interface CommandInjectionAnalysisObserver {
  onFileAnalyzed?(event: CommandInjectionFileAnalyzedEvent): void;
  onFileSkipped?(event: CommandInjectionFileSkippedEvent): void;
}

export interface CommandInjectionAnalysisMetricsSnapshot {
  filesAnalyzed: number;
  filesSkipped: number;
  skippedByReason: Partial<Record<CommandInjectionSkipReason, number>>;
  findingsByRule: Record<string, number>;
  totalFindings: number;
  totalDurationMs: number;
}

export class CommandInjectionAnalysisMetrics implements CommandInjectionAnalysisObserver {
  private filesAnalyzed = 0;
  private filesSkipped = 0;
  private totalDurationMs = 0;
  private readonly skippedByReason: Partial<Record<CommandInjectionSkipReason, number>> = {};
  private readonly findingsByRule: Record<string, number> = {};

  onFileAnalyzed(event: CommandInjectionFileAnalyzedEvent): void {
    this.filesAnalyzed++;
    this.totalDurationMs += event.durationMs;
    for (const [ruleId, count] of Object.entries(event.findingsByRule)) {
      this.findingsByRule[ruleId] = (this.findingsByRule[ruleId] ?? 0) + count;
    }
  }

  onFileSkipped(event: CommandInjectionFileSkippedEvent): void {
    this.filesSkipped++;
    this.skippedByReason[event.reason] = (this.skippedByReason[event.reason] ?? 0) + 1;
  }

  snapshot(): CommandInjectionAnalysisMetricsSnapshot {
    const findingsByRule = { ...this.findingsByRule };
    return {
      filesAnalyzed: this.filesAnalyzed,
      filesSkipped: this.filesSkipped,
      skippedByReason: { ...this.skippedByReason },
      findingsByRule,
      totalFindings: Object.values(findingsByRule).reduce((a, b) => a + b, 0),
      totalDurationMs: this.totalDurationMs,
    };
  }
}

export function notifySafely(invoke: () => void): void {
  try {
    invoke();
  } catch {
    // Telemetry must not affect analysis outcome.
  }
}
