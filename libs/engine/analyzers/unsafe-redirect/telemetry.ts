/**
 * Telemetry hooks for the unsafe redirect analyzer.
 *
 * Events carry only file paths, rule ids, counts, durations and skip reasons.
 * They never carry source text, redirect targets, or matched literals, because
 * analyzed repositories routinely embed credentials in URLs and config.
 */

export type RedirectSkipReason =
  | "unsupported-file-type"
  | "declaration-file"
  | "file-too-large"
  | "binary-content"
  | "invalid-input"
  | "excluded-by-config";

export interface RedirectFileAnalyzedEvent {
  file: string;
  durationMs: number;
  findingsByRule: Record<string, number>;
}

export interface RedirectFileSkippedEvent {
  file: string;
  reason: RedirectSkipReason;
}

export interface RedirectAnalysisObserver {
  onFileAnalyzed?(event: RedirectFileAnalyzedEvent): void;
  onFileSkipped?(event: RedirectFileSkippedEvent): void;
}

export interface RedirectAnalysisMetricsSnapshot {
  filesAnalyzed: number;
  filesSkipped: number;
  skippedByReason: Partial<Record<RedirectSkipReason, number>>;
  findingsByRule: Record<string, number>;
  totalFindings: number;
  totalDurationMs: number;
}

/** In-process counters; export via whatever metrics backend the host uses. */
export class RedirectAnalysisMetrics implements RedirectAnalysisObserver {
  private filesAnalyzed = 0;
  private filesSkipped = 0;
  private totalDurationMs = 0;
  private readonly skippedByReason: Partial<Record<RedirectSkipReason, number>> = {};
  private readonly findingsByRule: Record<string, number> = {};

  onFileAnalyzed(event: RedirectFileAnalyzedEvent): void {
    this.filesAnalyzed++;
    this.totalDurationMs += event.durationMs;
    for (const [ruleId, count] of Object.entries(event.findingsByRule)) {
      this.findingsByRule[ruleId] = (this.findingsByRule[ruleId] ?? 0) + count;
    }
  }

  onFileSkipped(event: RedirectFileSkippedEvent): void {
    this.filesSkipped++;
    this.skippedByReason[event.reason] = (this.skippedByReason[event.reason] ?? 0) + 1;
  }

  snapshot(): RedirectAnalysisMetricsSnapshot {
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

/** Invoke an observer hook without letting a faulty observer break analysis. */
export function notifySafely(invoke: () => void): void {
  try {
    invoke();
  } catch {
    // Telemetry must never change analysis results.
  }
}
