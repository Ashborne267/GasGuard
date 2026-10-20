import {
  StructuredScanFailure,
  ScanFailureCategory,
  ScanStage,
} from '../types/scan-observability.types';

export class ScanFailureTaxonomyService {
  private failures: StructuredScanFailure[] = [];

  public classifyFailure(
    scanId: string,
    tenantId: string,
    error: Error | unknown,
    stage: ScanStage,
    context?: Record<string, unknown>,
  ): StructuredScanFailure {
    const failureId = `fail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const message = error instanceof Error ? error.message : String(error);
    const { category, errorCode, retryable } = this.resolveCategory(error, message, stage);

    const failure: StructuredScanFailure = {
      failureId,
      scanId,
      tenantId,
      category,
      errorCode,
      message,
      stage,
      retryable,
      timestamp: Date.now(),
      context,
    };

    this.failures.push(failure);
    return failure;
  }

  private resolveCategory(
    error: unknown,
    message: string,
    stage: ScanStage,
  ): { category: ScanFailureCategory; errorCode: string; retryable: boolean } {
    const msg = message.toLowerCase();

    if (msg.includes('syntax') || msg.includes('parse error')) {
      return { category: 'SYNTAX_ERROR', errorCode: 'SCAN_SYNTAX_ERR', retryable: false };
    }
    if (msg.includes('timeout') || msg.includes('deadline exceeded')) {
      return { category: 'TIMEOUT', errorCode: 'SCAN_TIMEOUT', retryable: true };
    }
    if (msg.includes('out of memory') || msg.includes('heap') || msg.includes('resource')) {
      return { category: 'RESOURCE_EXHAUSTION', errorCode: 'SCAN_OOM', retryable: false };
    }
    if (msg.includes('dependency') || msg.includes('cannot find package')) {
      return { category: 'DEPENDENCY_RESOLVE_ERROR', errorCode: 'SCAN_DEP_MISSING', retryable: false };
    }
    if (msg.includes('network') || msg.includes('econnreset') || msg.includes('etimedout')) {
      return { category: 'NETWORK_IO_ERROR', errorCode: 'SCAN_NET_IO', retryable: true };
    }
    if (stage === 'rule_evaluation') {
      return { category: 'RULE_EXECUTION_FAILURE', errorCode: 'SCAN_RULE_ERR', retryable: false };
    }

    return { category: 'INTERNAL_ERROR', errorCode: 'SCAN_INTERNAL_ERR', retryable: true };
  }

  public getFailuresByTenant(tenantId: string): StructuredScanFailure[] {
    return this.failures.filter((f) => f.tenantId === tenantId);
  }

  public getFailuresByCategory(category: ScanFailureCategory): StructuredScanFailure[] {
    return this.failures.filter((f) => f.category === category);
  }

  public clear(): void {
    this.failures = [];
  }
}
