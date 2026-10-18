import { ScanStageHistogramService } from './metrics/scan-stage-histogram.service';
import { AnalyzerSaturationMetricsService } from './metrics/analyzer-saturation-metrics.service';
import { ScanFailureTaxonomyService } from './taxonomy/scan-failure-taxonomy.service';
import { ScanThroughputDashboardService } from './dashboard/scan-throughput-dashboard.service';

describe('Scan Observability Services (#1259, #1260, #1261, #1264)', () => {
  describe('ScanStageHistogramService (#1259)', () => {
    let service: ScanStageHistogramService;

    beforeEach(() => {
      service = new ScanStageHistogramService([100, 500, 1000]);
    });

    it('should record durations and increment correct histogram buckets', () => {
      service.recordStageDuration('ast_generation', 50);
      service.recordStageDuration('ast_generation', 300);
      service.recordStageDuration('ast_generation', 800);

      const hist = service.getHistogram('ast_generation');
      expect(hist).not.toBeNull();
      expect(hist?.count).toBe(3);
      expect(hist?.sumMs).toBe(1150);

      // Bucket <= 100 should have 1 item (50)
      const b100 = hist?.buckets.find((b) => b.le === 100);
      expect(b100?.count).toBe(1);

      // Bucket <= 500 should have 2 items (50, 300)
      const b500 = hist?.buckets.find((b) => b.le === 500);
      expect(b500?.count).toBe(2);

      // Bucket <= 1000 should have 3 items (50, 300, 800)
      const b1000 = hist?.buckets.find((b) => b.le === 1000);
      expect(b1000?.count).toBe(3);
    });
  });

  describe('AnalyzerSaturationMetricsService (#1260)', () => {
    let service: AnalyzerSaturationMetricsService;

    beforeEach(() => {
      service = new AnalyzerSaturationMetricsService(5);
    });

    it('should track active workers, queue wait time and saturation ratio', () => {
      service.jobEnqueued('job-1', Date.now() - 2000);
      service.jobEnqueued('job-2', Date.now() - 1000);

      const wait = service.jobStarted('job-1');
      expect(wait).toBeGreaterThanOrEqual(1900);

      const metrics = service.getMetrics();
      expect(metrics.activeWorkers).toBe(1);
      expect(metrics.maxWorkers).toBe(5);
      expect(metrics.queuedJobs).toBe(1);
      expect(metrics.saturationRatio).toBe(0.2);
      expect(metrics.isSaturated).toBe(false);

      service.jobFinished();
      const updated = service.getMetrics();
      expect(updated.activeWorkers).toBe(0);
    });
  });

  describe('ScanFailureTaxonomyService (#1261)', () => {
    let service: ScanFailureTaxonomyService;

    beforeEach(() => {
      service = new ScanFailureTaxonomyService();
    });

    it('should classify failures into structured taxonomy categories', () => {
      const f1 = service.classifyFailure(
        'scan-1',
        'tenant-a',
        new Error('Unexpected token in line 5: syntax error'),
        'ast_generation',
      );
      expect(f1.category).toBe('SYNTAX_ERROR');
      expect(f1.retryable).toBe(false);

      const f2 = service.classifyFailure(
        'scan-2',
        'tenant-a',
        new Error('Operation timeout: deadline exceeded'),
        'cloning',
      );
      expect(f2.category).toBe('TIMEOUT');
      expect(f2.retryable).toBe(true);

      const f3 = service.classifyFailure(
        'scan-3',
        'tenant-b',
        new Error('Heap allocation failed: JavaScript out of memory'),
        'rule_evaluation',
      );
      expect(f3.category).toBe('RESOURCE_EXHAUSTION');

      const tenantFailures = service.getFailuresByTenant('tenant-a');
      expect(tenantFailures.length).toBe(2);
    });
  });

  describe('ScanThroughputDashboardService (#1264)', () => {
    let service: ScanThroughputDashboardService;

    beforeEach(() => {
      service = new ScanThroughputDashboardService();
    });

    it('should calculate scan throughput, files per second and success rate', () => {
      const now = Date.now();
      service.recordScan({
        scanId: 's-1',
        tenantId: 'tenant-1',
        repository: 'repo-a',
        filesScanned: 100,
        durationMs: 2000,
        timestamp: now,
        success: true,
      });

      service.recordScan({
        scanId: 's-2',
        tenantId: 'tenant-1',
        repository: 'repo-b',
        filesScanned: 50,
        durationMs: 1000,
        timestamp: now,
        success: false,
      });

      const summary = service.getSummary(60000, 'tenant-1');
      expect(summary.totalScans).toBe(2);
      expect(summary.successfulScans).toBe(1);
      expect(summary.failedScans).toBe(1);
      expect(summary.successRate).toBe(50);
      expect(summary.totalFilesScanned).toBe(150);
      expect(summary.scansPerMinute).toBe(2);
      expect(summary.avgDurationMs).toBe(1500);
    });
  });
});
