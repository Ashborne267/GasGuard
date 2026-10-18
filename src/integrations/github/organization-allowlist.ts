/**
 * GitHub Organization Allowlist (#1042)
 * 
 * Enforces organization-level access policies, supporting exact matching,
 * wildcard/glob patterns, case insensitivity, cached author membership verification,
 * and comprehensive audit logging.
 */

import { GitHubClient } from './github-client';
import {
  GitHubRepository,
  OrganizationAllowlistConfig,
  OrganizationValidationResult,
} from './types';

export class OrganizationAllowlist {
  private config: OrganizationAllowlistConfig;
  private client?: GitHubClient;
  private memberCache: Map<string, { isMember: boolean; expiresAt: number }>;

  constructor(config: OrganizationAllowlistConfig, client?: GitHubClient) {
    this.config = {
      allowedOrganizations: [...config.allowedOrganizations],
      allowWildcards: config.allowWildcards ?? true,
      strictCase: config.strictCase ?? false,
      cacheTtlSeconds: config.cacheTtlSeconds ?? 300,
      requireVerifiedMembers: config.requireVerifiedMembers ?? false,
    };
    this.client = client;
    this.memberCache = new Map();
  }

  /**
   * Check if an organization name matches the allowlist
   */
  isAllowed(organization: string): boolean {
    if (!organization || this.config.allowedOrganizations.length === 0) {
      return false;
    }

    const orgToTest = this.config.strictCase ? organization : organization.toLowerCase();

    for (const pattern of this.config.allowedOrganizations) {
      const targetPattern = this.config.strictCase ? pattern : pattern.toLowerCase();

      if (this.config.allowWildcards && targetPattern.includes('*')) {
        const regex = new RegExp(`^${targetPattern.replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&').replace(/\*/g, '.*')}$`);
        if (regex.test(orgToTest)) {
          return true;
        }
      } else if (orgToTest === targetPattern) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validate a repository against the organization allowlist
   */
  validateRepository(repository: GitHubRepository | string): OrganizationValidationResult {
    const owner = typeof repository === 'string'
      ? repository.split('/')[0]
      : repository.owner;

    if (!owner) {
      return {
        allowed: false,
        organization: '',
        reason: 'Missing repository owner/organization',
        timestamp: new Date(),
      };
    }

    const allowed = this.isAllowed(owner);
    let matchedPattern: string | undefined;

    if (allowed) {
      matchedPattern = this.findMatchingPattern(owner);
    }

    return {
      allowed,
      organization: owner,
      matchedPattern,
      reason: allowed
        ? `Organization '${owner}' matches allowlist rule '${matchedPattern}'`
        : `Organization '${owner}' is not present in the allowlist`,
      timestamp: new Date(),
    };
  }

  /**
   * Validate pull request author against organization membership
   */
  async validateAuthor(organization: string, username: string): Promise<OrganizationValidationResult> {
    const orgResult = this.validateRepository({ owner: organization, repo: '', isPrivate: false, defaultBranch: 'main' });

    if (!orgResult.allowed) {
      return orgResult;
    }

    if (!this.config.requireVerifiedMembers || !this.client) {
      return orgResult;
    }

    // Check membership cache
    const cacheKey = `${organization}:${username}`.toLowerCase();
    const cached = this.memberCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return {
        ...orgResult,
        allowed: cached.isMember,
        isMember: cached.isMember,
        reason: cached.isMember
          ? `User '${username}' is a verified member of '${organization}' (cached)`
          : `User '${username}' is not a verified member of '${organization}' (cached)`,
      };
    }

    try {
      const isMember = await this.client.isOrgMember(organization, username);
      const ttlMs = (this.config.cacheTtlSeconds ?? 300) * 1000;
      this.memberCache.set(cacheKey, { isMember, expiresAt: now + ttlMs });

      return {
        ...orgResult,
        allowed: isMember,
        isMember,
        reason: isMember
          ? `User '${username}' is a verified member of '${organization}'`
          : `User '${username}' is not a verified member of '${organization}'`,
      };
    } catch (error) {
      return {
        ...orgResult,
        allowed: false,
        isMember: false,
        reason: `Failed to verify membership for '${username}' in '${organization}': ${error}`,
      };
    }
  }

  /**
   * Add an organization or wildcard pattern to the allowlist
   */
  addAllowedOrganization(organization: string): void {
    if (!this.config.allowedOrganizations.includes(organization)) {
      this.config.allowedOrganizations.push(organization);
    }
  }

  /**
   * Remove an organization from the allowlist
   */
  removeAllowedOrganization(organization: string): void {
    this.config.allowedOrganizations = this.config.allowedOrganizations.filter(
      (org) => org !== organization
    );
  }

  /**
   * Get all currently allowed organizations/patterns
   */
  getAllowedOrganizations(): string[] {
    return [...this.config.allowedOrganizations];
  }

  /**
   * Clear the membership cache
   */
  clearCache(): void {
    this.memberCache.clear();
  }

  /**
   * Find which pattern matched the organization
   */
  private findMatchingPattern(organization: string): string | undefined {
    const orgToTest = this.config.strictCase ? organization : organization.toLowerCase();

    for (const pattern of this.config.allowedOrganizations) {
      const targetPattern = this.config.strictCase ? pattern : pattern.toLowerCase();
      if (this.config.allowWildcards && targetPattern.includes('*')) {
        const regex = new RegExp(`^${targetPattern.replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&').replace(/\*/g, '.*')}$`);
        if (regex.test(orgToTest)) return pattern;
      } else if (orgToTest === targetPattern) {
        return pattern;
      }
    }

    return undefined;
  }
}
