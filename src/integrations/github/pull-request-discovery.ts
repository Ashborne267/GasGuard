/**
 * Pull Request File Discovery (#1043)
 * 
 * Provides automated discovery and analysis of changed files in GitHub pull requests,
 * including pagination handling, status categorization, contract file isolation,
 * and security-sensitive change detection.
 */

import { GitHubClient } from './github-client';
import {
  GitHubRepository,
  PullRequestFile,
  PullRequestChangeSummary,
  PullRequestDiscoveryOptions,
} from './types';

export class PullRequestFileDiscovery {
  private client: GitHubClient;
  private repository: GitHubRepository;

  // Patterns that indicate configuration or security-sensitive components
  private static readonly SECURITY_SENSITIVE_PATTERNS = [
    /^\.github\/workflows\//i,
    /^\.github\/actions\//i,
    /^contracts\/.*audit/i,
    /^contracts\/.*access/i,
    /^src\/security\//i,
    /^rules\//i,
    /\.env(\..+)?$/i,
    /hardhat\.config\.(ts|js)$/i,
    /foundry\.toml$/i,
    /Cargo\.(toml|lock)$/i,
    /package(-lock)?\.json$/i,
    /pnpm-lock\.yaml$/i,
  ];

  // Smart contract file extensions
  private static readonly SMART_CONTRACT_EXTENSIONS = [
    '.sol',
    '.rs',
    '.vy',
    '.cairo',
    '.fe',
  ];

  constructor(client: GitHubClient, repository: GitHubRepository) {
    this.client = client;
    this.repository = repository;
  }

  /**
   * Fetch all changed files for a pull request, handling pagination up to maxFiles
   */
  async getChangedFiles(
    pullNumber: number,
    options: PullRequestDiscoveryOptions = {}
  ): Promise<PullRequestFile[]> {
    const maxFiles = options.maxFiles ?? 300;
    const perPage = Math.min(100, maxFiles);
    let page = 1;
    let allFiles: PullRequestFile[] = [];
    let hasMore = true;

    while (hasMore && allFiles.length < maxFiles) {
      const rawFiles = await this.client.getPullRequestFiles(
        this.repository.owner,
        this.repository.repo,
        pullNumber,
        page,
        perPage
      );

      if (!rawFiles || rawFiles.length === 0) {
        break;
      }

      for (const item of rawFiles) {
        if (allFiles.length >= maxFiles) break;

        const file: PullRequestFile = {
          sha: item.sha,
          filename: item.filename,
          status: item.status,
          additions: item.additions ?? 0,
          deletions: item.deletions ?? 0,
          changes: item.changes ?? (item.additions ?? 0) + (item.deletions ?? 0),
          blobUrl: item.blob_url,
          rawUrl: item.raw_url,
          contentsUrl: item.contents_url,
          patch: options.includePatch ? item.patch : undefined,
          previousFilename: item.previous_filename,
        };

        if (this.matchesOptions(file.filename, options)) {
          allFiles.push(file);
        }
      }

      if (rawFiles.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return allFiles;
  }

  /**
   * Get an aggregated change summary for a pull request
   */
  async getChangeSummary(
    pullNumber: number,
    options: PullRequestDiscoveryOptions = {}
  ): Promise<PullRequestChangeSummary> {
    const files = await this.getChangedFiles(pullNumber, options);

    let additions = 0;
    let deletions = 0;
    let changes = 0;
    const filesByStatus: Record<string, number> = {};
    const affectedFileTypes: Record<string, number> = {};
    const criticalFilesTouched: string[] = [];

    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
      changes += file.changes;

      // Track status
      filesByStatus[file.status] = (filesByStatus[file.status] ?? 0) + 1;

      // Track file extension
      const ext = this.getFileExtension(file.filename);
      affectedFileTypes[ext] = (affectedFileTypes[ext] ?? 0) + 1;

      // Check critical/security file
      if (this.isSecurityOrConfigFile(file.filename)) {
        criticalFilesTouched.push(file.filename);
      }
    }

    return {
      totalFiles: files.length,
      additions,
      deletions,
      changes,
      files,
      filesByStatus,
      affectedFileTypes,
      hasSecurityOrConfigFileChanges: criticalFilesTouched.length > 0,
      criticalFilesTouched,
    };
  }

  /**
   * Get only smart contract files modified in the pull request
   */
  async getContractFiles(pullNumber: number): Promise<PullRequestFile[]> {
    return this.getChangedFiles(pullNumber, {
      fileExtensions: PullRequestFileDiscovery.SMART_CONTRACT_EXTENSIONS,
    });
  }

  /**
   * Check whether any security or workflow files are touched in the pull request
   */
  async hasSecuritySensitiveChanges(pullNumber: number): Promise<boolean> {
    const files = await this.getChangedFiles(pullNumber, { maxFiles: 100 });
    return files.some((f) => this.isSecurityOrConfigFile(f.filename));
  }

  /**
   * Match filename against filtering options
   */
  private matchesOptions(filename: string, options: PullRequestDiscoveryOptions): boolean {
    if (options.fileExtensions && options.fileExtensions.length > 0) {
      const ext = this.getFileExtension(filename);
      const matchesExt = options.fileExtensions.some(
        (e) => e.toLowerCase() === ext.toLowerCase() || `.${e.toLowerCase().replace(/^\./, '')}` === ext.toLowerCase()
      );
      if (!matchesExt) return false;
    }

    if (options.excludePatterns && options.excludePatterns.length > 0) {
      for (const pattern of options.excludePatterns) {
        if (filename.includes(pattern) || filename.startsWith(pattern)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Determine file extension
   */
  private getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1 || lastDot === 0) return 'none';
    return filename.slice(lastDot).toLowerCase();
  }

  /**
   * Check if a filename matches known security or config patterns
   */
  private isSecurityOrConfigFile(filename: string): boolean {
    return PullRequestFileDiscovery.SECURITY_SENSITIVE_PATTERNS.some((pattern) =>
      pattern.test(filename)
    );
  }
}
