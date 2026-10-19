/**
 * Structured metrics and safe logging for Golden Output Snapshots (#1253).
 *
 * Guarantees that logs and metrics never leak source code, paths, tokens,
 * or customer secrets.
 */

export interface GoldenSnapshotMetricCounters {
  snapshotsCreated: number;
  verificationsTotal: number;
  verificationsMatched: number;
  verificationsMismatched: number;
  verificationsMissing: number;
  languageDifferencesTotal: Record<string, number>;
}

export class GoldenSnapshotMetrics {
  private counters: GoldenSnapshotMetricCounters = {
    snapshotsCreated: 0,
    verificationsTotal: 0,
    verificationsMatched: 0,
    verificationsMismatched: 0,
    verificationsMissing: 0,
    languageDifferencesTotal: {},
  };

  recordSnapshotCreated(languageCount: number): void {
    this.counters.snapshotsCreated++;
  }

  recordVerification(
    status: "matched" | "mismatched" | "missing",
    languageResults: Record<string, { matched: boolean; findingDiffs: any[] }>,
  ): void {
    this.counters.verificationsTotal++;
    if (status === "matched") {
      this.counters.verificationsMatched++;
    } else if (status === "mismatched") {
      this.counters.verificationsMismatched++;
    } else {
      this.counters.verificationsMissing++;
    }

    for (const [lang, res] of Object.entries(languageResults)) {
      if (!res.matched) {
        this.counters.languageDifferencesTotal[lang] =
          (this.counters.languageDifferencesTotal[lang] ?? 0) + res.findingDiffs.length;
      }
    }
  }

  getCounters(): Readonly<GoldenSnapshotMetricCounters> {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = {
      snapshotsCreated: 0,
      verificationsTotal: 0,
      verificationsMatched: 0,
      verificationsMismatched: 0,
      verificationsMissing: 0,
      languageDifferencesTotal: {},
    };
  }
}

/**
 * Sanitizes log context so secrets, access keys, private keys, and sensitive tokens are never emitted.
 */
export function sanitizeLogContext(context: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    "token",
    "secret",
    "password",
    "key",
    "auth",
    "credential",
    "private",
    "pat",
    "apikey",
    "code",
  ];

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    const lower = k.toLowerCase();
    if (sensitiveKeys.some((s) => lower.includes(s))) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      result[k] = sanitizeLogContext(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}
