import { PolicyAuditManager } from './policy-audit';
import type { OrganizationPolicy } from './config.types';

describe('Policy Change Audit History (#1067)', () => {
  let auditManager: PolicyAuditManager;

  beforeEach(() => {
    auditManager = new PolicyAuditManager();
  });

  it('records normal policy creation and update audit history with integrity hashes', () => {
    const initialPolicy: OrganizationPolicy = {
      id: 'sec-policy-1',
      organizationId: 'acme',
      rules: [{ ruleId: 'reentrancy-guard', enabled: true, severity: 'high' }],
    };

    const createRecord = auditManager.recordChange('sec-policy-1', 'create', null, initialPolicy, 'admin-user');
    expect(createRecord.action).toBe('create');
    expect(createRecord.integrityHash).toBeDefined();
    expect(auditManager.verifyIntegrity(createRecord.id)).toBe(true);

    const updatedPolicy: OrganizationPolicy = {
      ...initialPolicy,
      rules: [{ ruleId: 'reentrancy-guard', enabled: true, severity: 'critical' }],
    };
    const updateRecord = auditManager.recordChange('sec-policy-1', 'update', initialPolicy, updatedPolicy, 'admin-user');
    
    const history = auditManager.getHistory('sec-policy-1');
    expect(history.length).toBe(2);
    expect(auditManager.verifyIntegrity(updateRecord.id)).toBe(true);
  });

  it('fails integrity verification if audit record is tampered with', () => {
    const policy: OrganizationPolicy = {
      id: 'sec-policy-2',
      organizationId: 'acme',
      rules: [],
    };
    const record = auditManager.recordChange('sec-policy-2', 'create', null, policy, 'admin-user');
    
    record.triggeredBy = 'malicious-user';
    expect(auditManager.verifyIntegrity(record.id)).toBe(false);
  });
});
