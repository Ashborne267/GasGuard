# Merge Queue Analysis Guide

The Merge Queue Analyzer evaluates batches of pull requests before they are merged. It checks cumulative gas impact, overlapping file declarations, and risk scores.

## Core Features

- **Cumulative Gas Modeling:** Calculates the combined estimated gas delta.
- **Conflict Detection:** Flags files declared by multiple pull requests.
- **Risk Aggregation:** Identifies the highest risk score and can block critical-risk queues.
- **Validation:** Rejects queues that exceed the configured gas threshold or contain detected conflicts.

## Usage

\`\`\`typescript
import { MergeQueueAnalyzer } from '../src/ci/merge-queue-analyzer';

const analyzer = new MergeQueueAnalyzer({
  maxCumulativeGasDelta: 200000,
  failOnCriticalRisk: true,
});

const result = analyzer.analyzeQueue('main-queue', [
  {
    id: 'pr-45',
    prNumber: 45,
    title: 'Gas optimization',
    author: 'alice',
    estimatedGasDelta: -12000,
    riskScore: 'low',
  },
]);

if (!result.passedValidation) {
  console.error('Merge queue validation failed:', result);
  process.exit(1);
}
\`\`\`

## Notes

File overlap detection uses the files declared by each queue item; it does not independently inspect Git diffs. Gas deltas are summed as signed values. Integrate this analyzer into the actual CI workflow and validate its inputs before relying on it as a merge gate.
