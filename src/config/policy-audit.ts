import { createHash } from 'crypto';
import type { OrganizationPolicy } from './config.types';

export type PolicyAction = 'create' | 'update' | 'delete';

export interface PolicyChangeRecord {
  id: string;
  policyId: string;
  action: PolicyAction;
  previousPolicy: OrganizationPolicy | null;
  newPolicy: OrganizationPolicy | null;
  triggeredBy: string;
  timestamp: Date;
  integrityHash: string;
}

export class PolicyAuditManager {
  private auditHistory: PolicyChangeRecord[] = [];

  public recordChange(
    policyId: string,
    action: PolicyAction,
    previousPolicy: OrganizationPolicy | null,
    newPolicy: OrganizationPolicy | null,
    triggeredBy: string,
  ): PolicyChangeRecord {
    const timestamp = new Date();
    const rawData = JSON.stringify({
      policyId,
      action,
      previousPolicy,
      newPolicy,
      triggeredBy,
      timestamp: timestamp.toISOString(),
    });

    const integrityHash = createHash('sha256')
      .update(rawData)
      .digest('hex');

    const record: PolicyChangeRecord = {
      id: createHash('sha256')
        .update(`${policyId}:${action}:${Date.now()}`)
        .digest('hex')
        .slice(0, 16),
      policyId,
      action,
      previousPolicy,
      newPolicy,
      triggeredBy,
      timestamp,
      integrityHash,
    };

    this.auditHistory.push(record);
    return record;
  }

  public getHistory(policyId?: string): PolicyChangeRecord[] {
    if (policyId) {
      return this.auditHistory.filter((record) => record.policyId === policyId);
    }
    return [...this.auditHistory];
  }

  public verifyIntegrity(recordId: string): boolean {
    const record = this.auditHistory.find((r) => r.id === recordId);
    if (!record) return false;

    const rawData = JSON.stringify({
      policyId: record.policyId,
      action: record.action,
      previousPolicy: record.previousPolicy,
      newPolicy: record.newPolicy,
      triggeredBy: record.triggeredBy,
      timestamp: record.timestamp.toISOString(),
    });

    const expectedHash = createHash('sha256')
      .update(rawData)
      .digest('hex');

    return expectedHash === record.integrityHash;
  }
}

export const globalPolicyAuditManager = new PolicyAuditManager();
