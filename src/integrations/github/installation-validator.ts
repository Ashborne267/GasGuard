/**
 * GitHub App Repository Installation Validation (#1041)
 * 
 * Validates GitHub App installation status, repository selection scope,
 * and granted repository permissions with permission hierarchy checking
 * and actionable remediation diagnostics.
 */

import axios from 'axios';
import { GitHubClient } from './github-client';
import {
  GitHubRepository,
  InstallationValidationResult,
  InstallationValidationOptions,
} from './types';

export class InstallationValidator {
  private client: GitHubClient;
  private defaultRepository?: GitHubRepository;

  // Permission levels for comparison
  private static readonly PERMISSION_HIERARCHY: Record<string, number> = {
    none: 0,
    read: 1,
    write: 2,
    admin: 3,
  };

  constructor(client: GitHubClient, defaultRepository?: GitHubRepository) {
    this.client = client;
    this.defaultRepository = defaultRepository;
  }

  /**
   * Validate that the GitHub App is correctly installed on a repository with required permissions
   */
  async validateRepositoryInstallation(
    owner?: string,
    repo?: string,
    options: InstallationValidationOptions = {}
  ): Promise<InstallationValidationResult> {
    const targetOwner = owner ?? this.defaultRepository?.owner;
    const targetRepo = repo ?? this.defaultRepository?.repo;

    if (!targetOwner || !targetRepo) {
      return {
        valid: false,
        targetType: 'Unknown',
        repositorySelection: 'selected',
        permissions: {},
        missingRequiredPermissions: [],
        status: 'not_installed',
        errors: ['Target owner and repo must be provided or configured in repository context.'],
      };
    }

    try {
      const data = await this.client.getRepositoryInstallation(targetOwner, targetRepo);
      return this.evaluateInstallationData(data, options);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          return {
            valid: false,
            targetType: 'Unknown',
            repositorySelection: 'selected',
            permissions: {},
            missingRequiredPermissions: options.requiredPermissions
              ? Object.keys(options.requiredPermissions)
              : [],
            status: 'not_installed',
            errors: [`GitHub App is not installed on repository '${targetOwner}/${targetRepo}'.`],
            details: 'Please install the GitHub App from your organization or repository settings.',
          };
        }

        if (error.response?.status === 401 || error.response?.status === 403) {
          return {
            valid: false,
            targetType: 'Unknown',
            repositorySelection: 'selected',
            permissions: {},
            missingRequiredPermissions: [],
            status: 'unauthorized',
            errors: [`Insufficient credentials to query installation on '${targetOwner}/${targetRepo}'.`],
          };
        }
      }

      return {
        valid: false,
        targetType: 'Unknown',
        repositorySelection: 'selected',
        permissions: {},
        missingRequiredPermissions: [],
        status: 'not_installed',
        errors: [`Failed to validate installation on '${targetOwner}/${targetRepo}': ${error}`],
      };
    }
  }

  /**
   * Validate an installation by its installation ID directly
   */
  async validateAppInstallation(
    installationId: number | string,
    options: InstallationValidationOptions = {}
  ): Promise<InstallationValidationResult> {
    try {
      const data = await this.client.getAppInstallation(installationId);
      return this.evaluateInstallationData(data, options);
    } catch (error) {
      return {
        valid: false,
        installationId: typeof installationId === 'number' ? installationId : parseInt(installationId, 10),
        targetType: 'Unknown',
        repositorySelection: 'selected',
        permissions: {},
        missingRequiredPermissions: [],
        status: 'not_installed',
        errors: [`Failed to query installation ID ${installationId}: ${error}`],
      };
    }
  }

  /**
   * Evaluate raw GitHub installation payload against options and permission requirements
   */
  private evaluateInstallationData(
    data: any,
    options: InstallationValidationOptions
  ): InstallationValidationResult {
    const isSuspended = Boolean(data.suspended_at);
    const status = isSuspended ? 'suspended' : 'active';
    const permissions: Record<string, string> = data.permissions ?? {};
    const errors: string[] = [];

    if (isSuspended) {
      errors.push(`Installation is suspended (by: ${data.suspended_by?.login ?? 'administrator'}).`);
    }

    // Check required permissions
    const missingPermissions: string[] = [];
    if (options.requiredPermissions) {
      for (const [perm, requiredLevel] of Object.entries(options.requiredPermissions)) {
        const actualLevel = permissions[perm] ?? 'none';
        const actualRank = InstallationValidator.PERMISSION_HIERARCHY[actualLevel] ?? 0;
        const requiredRank = InstallationValidator.PERMISSION_HIERARCHY[requiredLevel] ?? 0;

        if (actualRank < requiredRank) {
          missingPermissions.push(`${perm}:${requiredLevel} (current: ${actualLevel})`);
        }
      }
    }

    if (missingPermissions.length > 0) {
      errors.push(`Missing required installation permissions: ${missingPermissions.join(', ')}`);
    }

    const isValid = !isSuspended && missingPermissions.length === 0;

    return {
      valid: isValid,
      installationId: data.id,
      targetType: data.target_type ?? 'Unknown',
      targetId: data.target_id,
      repositorySelection: data.repository_selection ?? 'selected',
      permissions,
      missingRequiredPermissions: missingPermissions,
      status,
      suspendedAt: data.suspended_at ? new Date(data.suspended_at) : null,
      suspendedBy: data.suspended_by?.login ?? null,
      errors,
      details: isValid
        ? `Installation #${data.id} is active with all required permissions.`
        : `Installation #${data.id} has validation issues: ${errors.join('; ')}`,
    };
  }
}
