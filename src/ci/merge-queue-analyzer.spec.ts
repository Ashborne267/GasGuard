import { MergeQueueAnalyzer, MergeQueueItem } from './merge-queue-analyzer';

describe('MergeQueueAnalyzer (#1076)', () => {
  let analyzer: MergeQueueAnalyzer;

  beforeEach(() => {
    analyzer = new MergeQueueAnalyzer({
      maxCumulativeGasDelta: 100000,
      failOnCriticalRisk: true,
    });
  });

  it('successfully analyzes a healthy merge queue', () => {
    const items: MergeQueueItem[] = [
      {
        id: 'pr-1',
        prNumber: 101,
        title: 'Optimize storage slots',
        author: 'dev1',
        estimatedGasDelta: -5000,
        riskScore: 'low',
      },
      {
        id: 'pr-2',
        prNumber: 102,
        title: 'Add helper function',
        author: 'dev2',
        estimatedGasDelta: 2000,
        riskScore: 'medium',
      },
    ];

    const result = analyzer.analyzeQueue('queue-alpha', items);

    expect(result.passedValidation).toBe(true);
    expect(result.cumulativeGasDelta).toBe(-3000);
    expect(result.totalItems).toBe(2);
    expect(result.highestRisk).toBe('medium');
    expect(result.conflictsDetected).toHaveLength(0);
  });

  it('fails when cumulative gas delta exceeds the threshold', () => {
    const items: MergeQueueItem[] = [
      {
        id: 'pr-1',
        prNumber: 201,
        title: 'Heavy state initialization',
        author: 'dev1',
        estimatedGasDelta: 150000,
        riskScore: 'low',
      },
    ];

    const result = analyzer.analyzeQueue('queue-beta', items);

    expect(result.passedValidation).toBe(false);
    expect(result.cumulativeGasDelta).toBe(150000);
  });

  it('detects file conflicts and critical risk failures', () => {
    const items: MergeQueueItem[] = [
      {
        id: 'pr-1',
        prNumber: 301,
        title: 'Token update',
        author: 'dev1',
        estimatedGasDelta: 10000,
        riskScore: 'critical',
        conflictingFiles: ['contracts/Token.sol'],
      },
      {
        id: 'pr-2',
        prNumber: 302,
        title: 'Another token update',
        author: 'dev2',
        estimatedGasDelta: 5000,
        riskScore: 'low',
        conflictingFiles: ['contracts/Token.sol'],
      },
    ];

    const result = analyzer.analyzeQueue('queue-gamma', items);

    expect(result.passedValidation).toBe(false);
    expect(result.highestRisk).toBe('critical');
    expect(result.conflictsDetected).toHaveLength(1);
    expect(result.conflictsDetected[0]).toMatchObject({
      pr1: 301,
      pr2: 302,
      file: 'contracts/Token.sol',
    });
  });
});
