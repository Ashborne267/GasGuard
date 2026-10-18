/**
 * Unit tests for GitHub App Repository Installation Validation (#1041)
 */

import { InstallationValidator } from '../installation-validator';
import { GitHubClient } from '../github-client';
import { GitHubRepository } from '../types';

describe('InstallationValidator', () => {
  let validator: InstallationValidator;
  let mockClient: jest.Mocked<GitHubClient>;
  let repository: GitHubRepository;

  beforeEach(() => {
    repository = {
      owner: 'MDTechLabs',
      repo: 'GasGuard',
      isPrivate: false,
      defaultBranch: 'main',
    };

    mockClient = {
      getRepositoryInstallation: jest.fn(),
      getAppInstallation: jest.fn(),
    } as any;

    validator = new InstallationValidator(mockClient, repository);
  });

  describe('validateRepositoryInstallation', () => {
    it('should pass validation when installation is active with required permissions', async () => {
      mockClient.getRepositoryInstallation.mockResolvedValueOnce({
        id: 12345,
        target_type: 'Organization',
        target_id: 6789,
        repository_selection: 'all',
        permissions: {
          pull_requests: 'write',
          contents: 'read',
          checks: 'write',
        },
        suspended_at: null,
      });

      const result = await validator.validateRepositoryInstallation(undefined, undefined, {
        requiredPermissions: {
          pull_requests: 'read',
          contents: 'read',
        },
      });

      expect(result.valid).toBe(true);
      expect(result.status).toBe('active');
      expect(result.installationId).toBe(12345);
      expect(result.missingRequiredPermissions).toHaveLength(0);
      expect(mockClient.getRepositoryInstallation).toHaveBeenCalledWith('MDTechLabs', 'GasGuard');
    });

    it('should fail validation when installation is suspended', async () => {
      mockClient.getRepositoryInstallation.mockResolvedValueOnce({
        id: 9999,
        target_type: 'Organization',
        permissions: { pull_requests: 'read' },
        suspended_at: '2026-10-01T12:00:00Z',
        suspended_by: { login: 'security-admin' },
      });

      const result = await validator.validateRepositoryInstallation();

      expect(result.valid).toBe(false);
      expect(result.status).toBe('suspended');
      expect(result.suspendedBy).toBe('security-admin');
      expect(result.suspendedAt).toEqual(new Date('2026-10-01T12:00:00Z'));
      expect(result.errors[0]).toContain('Installation is suspended');
    });

    it('should detect missing required permissions and check permission hierarchy', async () => {
      mockClient.getRepositoryInstallation.mockResolvedValueOnce({
        id: 1111,
        target_type: 'Organization',
        permissions: {
          pull_requests: 'read', // only read, but write required
          contents: 'admin',     // admin satisfies write
        },
      });

      const result = await validator.validateRepositoryInstallation('MDTechLabs', 'GasGuard', {
        requiredPermissions: {
          pull_requests: 'write',
          contents: 'write',
          checks: 'read', // missing entirely
        },
      });

      expect(result.valid).toBe(false);
      expect(result.missingRequiredPermissions).toEqual([
        'pull_requests:write (current: read)',
        'checks:read (current: none)',
      ]);
    });

    it('should handle 404 when app is not installed', async () => {
      const error: any = new Error('Not Found');
      error.isAxiosError = true;
      error.response = { status: 404 };
      mockClient.getRepositoryInstallation.mockRejectedValueOnce(error);

      const result = await validator.validateRepositoryInstallation('MDTechLabs', 'UninstalledRepo');

      expect(result.valid).toBe(false);
      expect(result.status).toBe('not_installed');
      expect(result.details).toContain('Please install the GitHub App');
    });
  });

  describe('validateAppInstallation', () => {
    it('should validate directly by installation ID', async () => {
      mockClient.getAppInstallation.mockResolvedValueOnce({
        id: 54321,
        target_type: 'Organization',
        target_id: 101,
        repository_selection: 'selected',
        permissions: { issues: 'write' },
        suspended_at: null,
      });

      const result = await validator.validateAppInstallation(54321);

      expect(result.valid).toBe(true);
      expect(result.installationId).toBe(54321);
      expect(result.repositorySelection).toBe('selected');
      expect(mockClient.getAppInstallation).toHaveBeenCalledWith(54321);
    });
  });
});
