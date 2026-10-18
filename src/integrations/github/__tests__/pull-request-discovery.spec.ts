/**
 * Unit tests for Pull Request File Discovery (#1043)
 */

import { PullRequestFileDiscovery } from '../pull-request-discovery';
import { GitHubClient } from '../github-client';
import { GitHubRepository } from '../types';

describe('PullRequestFileDiscovery', () => {
  let discovery: PullRequestFileDiscovery;
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
      getPullRequestFiles: jest.fn(),
    } as any;

    discovery = new PullRequestFileDiscovery(mockClient, repository);
  });

  describe('getChangedFiles', () => {
    it('should fetch and map pull request changed files', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        {
          sha: 'sha1',
          filename: 'contracts/GasGuard.sol',
          status: 'modified',
          additions: 15,
          deletions: 5,
          changes: 20,
          blob_url: 'https://github.com/blob/1',
          raw_url: 'https://github.com/raw/1',
        },
        {
          sha: 'sha2',
          filename: 'test/GasGuard.t.sol',
          status: 'added',
          additions: 45,
          deletions: 0,
          changes: 45,
        },
      ]);

      const files = await discovery.getChangedFiles(123);

      expect(files).toHaveLength(2);
      expect(files[0].filename).toBe('contracts/GasGuard.sol');
      expect(files[0].status).toBe('modified');
      expect(files[0].additions).toBe(15);
      expect(files[1].filename).toBe('test/GasGuard.t.sol');
      expect(files[1].status).toBe('added');
      expect(mockClient.getPullRequestFiles).toHaveBeenCalledWith(
        'MDTechLabs',
        'GasGuard',
        123,
        1,
        100
      );
    });

    it('should paginate when a PR has more than 100 files', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        sha: `sha-${i}`,
        filename: `contracts/Token_${i}.sol`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      }));
      const page2 = [
        {
          sha: 'sha-101',
          filename: 'contracts/Token_101.sol',
          status: 'added',
          additions: 10,
          deletions: 0,
          changes: 10,
        },
      ];

      mockClient.getPullRequestFiles
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);

      const files = await discovery.getChangedFiles(456, { maxFiles: 150 });

      expect(files).toHaveLength(101);
      expect(mockClient.getPullRequestFiles).toHaveBeenCalledTimes(2);
      expect(mockClient.getPullRequestFiles).toHaveBeenNthCalledWith(1, 'MDTechLabs', 'GasGuard', 456, 1, 100);
      expect(mockClient.getPullRequestFiles).toHaveBeenNthCalledWith(2, 'MDTechLabs', 'GasGuard', 456, 2, 100);
    });

    it('should filter files by specified file extensions', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        { sha: '1', filename: 'contracts/Token.sol', status: 'modified' },
        { sha: '2', filename: 'README.md', status: 'modified' },
        { sha: '3', filename: 'src/lib.rs', status: 'added' },
        { sha: '4', filename: 'docs/guide.pdf', status: 'added' },
      ]);

      const files = await discovery.getChangedFiles(1, { fileExtensions: ['.sol', '.rs'] });

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.filename)).toEqual(['contracts/Token.sol', 'src/lib.rs']);
    });

    it('should filter out files matching exclude patterns', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        { sha: '1', filename: 'contracts/Token.sol', status: 'modified' },
        { sha: '2', filename: 'vendor/dependency.sol', status: 'modified' },
        { sha: '3', filename: 'node_modules/foo/index.js', status: 'added' },
      ]);

      const files = await discovery.getChangedFiles(1, {
        excludePatterns: ['vendor/', 'node_modules/'],
      });

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('contracts/Token.sol');
    });
  });

  describe('getChangeSummary', () => {
    it('should calculate metrics and detect security-sensitive files', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        {
          sha: '1',
          filename: 'contracts/Vault.sol',
          status: 'modified',
          additions: 20,
          deletions: 5,
          changes: 25,
        },
        {
          sha: '2',
          filename: '.github/workflows/ci.yml',
          status: 'modified',
          additions: 10,
          deletions: 2,
          changes: 12,
        },
        {
          sha: '3',
          filename: 'package.json',
          status: 'modified',
          additions: 2,
          deletions: 1,
          changes: 3,
        },
        {
          sha: '4',
          filename: 'docs/notes.md',
          status: 'added',
          additions: 50,
          deletions: 0,
          changes: 50,
        },
      ]);

      const summary = await discovery.getChangeSummary(99);

      expect(summary.totalFiles).toBe(4);
      expect(summary.additions).toBe(82);
      expect(summary.deletions).toBe(8);
      expect(summary.changes).toBe(90);
      expect(summary.filesByStatus).toEqual({ modified: 3, added: 1 });
      expect(summary.affectedFileTypes).toEqual({
        '.sol': 1,
        '.yml': 1,
        '.json': 1,
        '.md': 1,
      });
      expect(summary.hasSecurityOrConfigFileChanges).toBe(true);
      expect(summary.criticalFilesTouched).toEqual([
        '.github/workflows/ci.yml',
        'package.json',
      ]);
    });
  });

  describe('getContractFiles', () => {
    it('should return only smart contract files', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        { sha: '1', filename: 'contracts/Vault.sol', status: 'modified' },
        { sha: '2', filename: 'contracts/token.cairo', status: 'added' },
        { sha: '3', filename: 'contracts/escrow.vy', status: 'modified' },
        { sha: '4', filename: 'scripts/deploy.js', status: 'added' },
      ]);

      const contractFiles = await discovery.getContractFiles(77);

      expect(contractFiles).toHaveLength(3);
      expect(contractFiles.map((c) => c.filename)).toEqual([
        'contracts/Vault.sol',
        'contracts/token.cairo',
        'contracts/escrow.vy',
      ]);
    });
  });

  describe('hasSecuritySensitiveChanges', () => {
    it('should return true if workflow or config file is changed', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        { sha: '1', filename: '.github/workflows/deploy.yml', status: 'modified' },
      ]);

      const hasSensitive = await discovery.hasSecuritySensitiveChanges(12);
      expect(hasSensitive).toBe(true);
    });

    it('should return false if only non-critical files are changed', async () => {
      mockClient.getPullRequestFiles.mockResolvedValueOnce([
        { sha: '1', filename: 'src/utils/math.ts', status: 'modified' },
        { sha: '2', filename: 'README.md', status: 'modified' },
      ]);

      const hasSensitive = await discovery.hasSecuritySensitiveChanges(12);
      expect(hasSensitive).toBe(false);
    });
  });
});
