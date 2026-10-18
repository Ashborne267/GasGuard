/**
 * Unit tests for GitHub Organization Allowlist (#1042)
 */

import { OrganizationAllowlist } from '../organization-allowlist';
import { GitHubClient } from '../github-client';

describe('OrganizationAllowlist', () => {
  let mockClient: jest.Mocked<GitHubClient>;

  beforeEach(() => {
    mockClient = {
      isOrgMember: jest.fn(),
    } as any;
  });

  describe('isAllowed', () => {
    it('should allow exact organization names (case-insensitive by default)', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs', 'OpenZeppelin'],
      });

      expect(allowlist.isAllowed('MDTechLabs')).toBe(true);
      expect(allowlist.isAllowed('mdtechlabs')).toBe(true);
      expect(allowlist.isAllowed('OpenZeppelin')).toBe(true);
      expect(allowlist.isAllowed('UntrustedOrg')).toBe(false);
    });

    it('should respect strictCase setting when enabled', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs'],
        strictCase: true,
      });

      expect(allowlist.isAllowed('MDTechLabs')).toBe(true);
      expect(allowlist.isAllowed('mdtechlabs')).toBe(false);
    });

    it('should support wildcard patterns', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs-*', 'corp-*-prod'],
        allowWildcards: true,
      });

      expect(allowlist.isAllowed('MDTechLabs-Security')).toBe(true);
      expect(allowlist.isAllowed('mdtechlabs-core')).toBe(true);
      expect(allowlist.isAllowed('corp-infra-prod')).toBe(true);
      expect(allowlist.isAllowed('OtherOrg')).toBe(false);
    });

    it('should return false for empty or missing organization', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs'],
      });

      expect(allowlist.isAllowed('')).toBe(false);
    });
  });

  describe('validateRepository', () => {
    it('should validate string repository format', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs'],
      });

      const validResult = allowlist.validateRepository('MDTechLabs/GasGuard');
      expect(validResult.allowed).toBe(true);
      expect(validResult.organization).toBe('MDTechLabs');

      const invalidResult = allowlist.validateRepository('MaliciousOrg/BadRepo');
      expect(invalidResult.allowed).toBe(false);
      expect(invalidResult.organization).toBe('MaliciousOrg');
    });

    it('should validate GitHubRepository object', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['MDTechLabs'],
      });

      const result = allowlist.validateRepository({
        owner: 'MDTechLabs',
        repo: 'GasGuard',
        isPrivate: false,
        defaultBranch: 'main',
      });

      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('MDTechLabs');
    });
  });

  describe('validateAuthor with membership check', () => {
    it('should verify author membership via GitHub API and cache results', async () => {
      mockClient.isOrgMember.mockResolvedValueOnce(true);

      const allowlist = new OrganizationAllowlist(
        {
          allowedOrganizations: ['MDTechLabs'],
          requireVerifiedMembers: true,
          cacheTtlSeconds: 60,
        },
        mockClient
      );

      const result1 = await allowlist.validateAuthor('MDTechLabs', 'alice');
      expect(result1.allowed).toBe(true);
      expect(result1.isMember).toBe(true);
      expect(mockClient.isOrgMember).toHaveBeenCalledTimes(1);

      // Second call should hit the cache
      const result2 = await allowlist.validateAuthor('MDTechLabs', 'alice');
      expect(result2.allowed).toBe(true);
      expect(result2.isMember).toBe(true);
      expect(mockClient.isOrgMember).toHaveBeenCalledTimes(1); // not called again
    });

    it('should deny author if organization is not allowed', async () => {
      const allowlist = new OrganizationAllowlist(
        {
          allowedOrganizations: ['MDTechLabs'],
          requireVerifiedMembers: true,
        },
        mockClient
      );

      const result = await allowlist.validateAuthor('UnknownOrg', 'bob');
      expect(result.allowed).toBe(false);
      expect(mockClient.isOrgMember).not.toHaveBeenCalled();
    });

    it('should deny author if user is not a member of the organization', async () => {
      mockClient.isOrgMember.mockResolvedValueOnce(false);

      const allowlist = new OrganizationAllowlist(
        {
          allowedOrganizations: ['MDTechLabs'],
          requireVerifiedMembers: true,
        },
        mockClient
      );

      const result = await allowlist.validateAuthor('MDTechLabs', 'external-user');
      expect(result.allowed).toBe(false);
      expect(result.isMember).toBe(false);
    });
  });

  describe('dynamic allowlist management', () => {
    it('should allow adding and removing organizations dynamically', () => {
      const allowlist = new OrganizationAllowlist({
        allowedOrganizations: ['OrgA'],
      });

      expect(allowlist.isAllowed('OrgB')).toBe(false);

      allowlist.addAllowedOrganization('OrgB');
      expect(allowlist.isAllowed('OrgB')).toBe(true);
      expect(allowlist.getAllowedOrganizations()).toEqual(['OrgA', 'OrgB']);

      allowlist.removeAllowedOrganization('OrgA');
      expect(allowlist.isAllowed('OrgA')).toBe(false);
      expect(allowlist.getAllowedOrganizations()).toEqual(['OrgB']);
    });
  });
});
