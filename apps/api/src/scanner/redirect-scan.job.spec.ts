/**
 * Integration: redirect scan job -> engine analyzer -> findings persistence.
 */
import * as fs from 'fs';
import * as path from 'path';
import { UnsafeRedirectAnalyzer } from '@engine/analyzers/unsafe-redirect';
import { FindingsRepository } from '../findings/findings.repository';
import { FindingsService } from '../findings/findings.service';
import { MetricsCollector } from '../queue/metrics';
import {
  RedirectScanJobError,
  RedirectScanJobDeps,
  RedirectScanJobHandler,
  RedirectScanJobPayload,
  RedirectScanLogger,
} from './redirect-scan.job';

const FIXTURES = path.resolve(__dirname, '../../../../tests/fixtures/unsafe-redirect');

function repoFiles(name: string): Array<{ path: string; content: string }> {
  const root = path.join(FIXTURES, name);
  const out: Array<{ path: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ path: path.relative(root, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

function captureLogger(): RedirectScanLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (event, fields) => lines.push(JSON.stringify({ level: 'info', event, ...fields })),
    warn: (event, fields) => lines.push(JSON.stringify({ level: 'warn', event, ...fields })),
  };
}

function setup(overrides: RedirectScanJobDeps = {}) {
  const repo = new FindingsRepository();
  const findings = new FindingsService(repo);
  const logger = captureLogger();
  const metrics = new MetricsCollector();
  const handler = new RedirectScanJobHandler({ findings, logger, metrics, ...overrides });
  return { repo, findings, logger, metrics, handler };
}

const job = (over: Partial<RedirectScanJobPayload> = {}): RedirectScanJobPayload => ({
  organizationId: 'org-a',
  repositoryId: 'repo-1',
  analysisJobId: 'job-1',
  files: repoFiles('express-app'),
  ...over,
});

async function expectJobError(p: Promise<unknown>, code: string, retryable: boolean) {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(RedirectScanJobError);
  expect(err).toEqual(expect.objectContaining({ code, retryable }));
}

describe('RedirectScanJobHandler', () => {
  it('analyzes a repository and persists findings under the job tenant', async () => {
    const { handler, findings } = setup();
    const outcome = await handler.handle(job());

    expect(outcome).toEqual(
      expect.objectContaining({
        status: 'completed',
        filesReceived: 4,
        filesAnalyzed: 3,
        filesSkipped: 1,
        findingsDetected: 8,
        findingsPersisted: 8,
        findingsAlreadyPersisted: 0,
        findingsByRule: { 'redirect-001': 4, 'redirect-002': 2, 'redirect-003': 1, 'redirect-004': 1 },
        fileErrors: [],
      }),
    );

    const page = findings.list({ organizationId: 'org-a', repositoryId: 'repo-1', limit: 100 });
    expect(page.items).toHaveLength(8);
    expect(page.items.every((f) => f.organizationId === 'org-a' && f.analysisJobId === 'job-1')).toBe(true);
    const stored = page.items.find((f) => f.filePath === 'src/routes/auth.js' && f.line === 7)!;
    expect(stored).toEqual(
      expect.objectContaining({
        ruleId: 'redirect-001',
        title: 'Unvalidated Redirect Target',
        severity: 'high',
        status: 'open',
      }),
    );
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps tenants isolated and builds a fresh analyzer per job', async () => {
    const factory = jest.fn((o) => new UnsafeRedirectAnalyzer(o));
    const { handler, findings } = setup({ analyzerFactory: factory });

    await handler.handle(job({ organizationId: 'org-a' }));
    await handler.handle(job({ organizationId: 'org-b', files: repoFiles('node-service') }));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.results[0].value).not.toBe(factory.mock.results[1].value);

    const a = findings.list({ organizationId: 'org-a', limit: 100 }).items;
    const b = findings.list({ organizationId: 'org-b', limit: 100 }).items;
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(3);
    expect(a.some((f) => f.organizationId !== 'org-a')).toBe(false);
    expect(b.some((f) => f.organizationId !== 'org-b')).toBe(false);
    expect(findings.getForTenant(a[0].id, 'org-b')).toBeUndefined();
  });

  it('does not let a retry in one tenant deduplicate against another tenant', async () => {
    const { handler } = setup();
    await handler.handle(job({ organizationId: 'org-a' }));
    const b = await handler.handle(job({ organizationId: 'org-b' }));
    expect(b).toEqual(expect.objectContaining({ findingsPersisted: 8, findingsAlreadyPersisted: 0 }));
  });

  it('is idempotent across retries of the same job', async () => {
    const { handler, findings } = setup();
    await handler.handle(job());
    const retry = await handler.handle(job());
    expect(retry).toEqual(expect.objectContaining({ findingsPersisted: 0, findingsAlreadyPersisted: 8 }));
    expect(findings.list({ organizationId: 'org-a', limit: 100 }).items).toHaveLength(8);

    // A new analysis job for the same repository is a new run, linked by fingerprint.
    const rerun = await handler.handle(job({ analysisJobId: 'job-2' }));
    expect(rerun.findingsPersisted).toBe(8);
    const first = findings.list({ organizationId: 'org-a', analysisJobId: 'job-1', limit: 100 }).items;
    const second = findings.list({ organizationId: 'org-a', analysisJobId: 'job-2', limit: 100 }).items;
    const firstFingerprints = new Set(first.map((f) => f.fingerprint));
    expect(second.every((f) => firstFingerprints.has(f.fingerprint))).toBe(true);
  });

  it('resumes after a persistence failure without duplicating findings', async () => {
    const repo = new FindingsRepository();
    const service = new FindingsService(repo);
    const create = service.create.bind(service);
    let calls = 0;
    jest.spyOn(service, 'create').mockImplementation((input) => {
      if (++calls === 4) throw new Error('db unavailable: postgres://user:hunter2@db');
      return create(input);
    });
    const logger = captureLogger();
    const handler = new RedirectScanJobHandler({ findings: service, logger });

    await expectJobError(handler.handle(job()), 'PERSISTENCE_FAILED', true);
    expect(service.list({ organizationId: 'org-a', limit: 100 }).items).toHaveLength(3);
    expect(logger.lines.join('\n')).not.toContain('hunter2');

    const retry = await handler.handle(job());
    expect(retry).toEqual(expect.objectContaining({ findingsPersisted: 5, findingsAlreadyPersisted: 3 }));
    expect(service.list({ organizationId: 'org-a', limit: 100 }).items).toHaveLength(8);
  });

  it('reports partial success when individual files cannot be analyzed', async () => {
    const { handler, findings } = setup();
    const outcome = await handler.handle(
      job({
        files: [
          { path: 'big.js', content: `res.redirect(req.query.n);${' '.repeat(200)}` },
          { path: 'bin.js', content: 'res.redirect(req.query.n)\u0000' },
          { path: 'ok.js', content: 'res.redirect(req.query.n);' },
        ],
        config: { options: { unsafeRedirect: { maxFileBytes: 100 } } },
      }),
    );
    expect(outcome.status).toBe('partial');
    expect(outcome.fileErrors.map((e) => e.file).sort()).toEqual(['big.js', 'bin.js']);
    expect(outcome.findingsPersisted).toBe(1);
    expect(findings.list({ organizationId: 'org-a', limit: 100 }).items[0].filePath).toBe('ok.js');
  });

  it('completes with zero findings for an empty or non-JS repository', async () => {
    const { handler } = setup();
    expect(await handler.handle(job({ files: [] }))).toEqual(
      expect.objectContaining({ status: 'completed', filesAnalyzed: 0, findingsDetected: 0 }),
    );
    expect(
      await handler.handle(job({ files: [{ path: 'Vault.sol', content: 'contract V {}' }] })),
    ).toEqual(expect.objectContaining({ status: 'completed', filesSkipped: 1, findingsDetected: 0 }));
  });

  it.each([
    ['missing organization', { organizationId: '' }],
    ['control characters in id', { repositoryId: 'repo\n1' }],
    ['oversized id', { analysisJobId: 'x'.repeat(257) }],
    ['unknown schema version', { schemaVersion: 2 }],
    ['files not an array', { files: 'src/a.js' as any }],
    ['file without content', { files: [{ path: 'a.js' } as any] }],
    ['duplicate paths', { files: [{ path: 'a.js', content: '' }, { path: 'a.js', content: '' }] }],
    ['disallowed config key', { config: { incremental: true } as any }],
    ['bad timeout', { timeoutMs: 0 }],
  ])('rejects %s as a non-retryable INVALID_JOB', async (_name, over) => {
    const { handler, findings } = setup();
    await expectJobError(handler.handle(job(over as Partial<RedirectScanJobPayload>)), 'INVALID_JOB', false);
    expect(findings.list({ organizationId: 'org-a', limit: 100 }).items).toEqual([]);
  });

  it('rejects invalid analyzer options as non-retryable INVALID_CONFIG', async () => {
    const { handler, logger } = setup();
    await expectJobError(
      handler.handle(job({ config: { options: { unsafeRedirect: { proximityLines: 'ten' } } } })),
      'INVALID_CONFIG',
      false,
    );
    expect(logger.lines[0]).toContain('"code":"INVALID_CONFIG"');
  });

  it('turns an analyzer timeout into a retryable error and persists nothing', async () => {
    const hung = new UnsafeRedirectAnalyzer();
    jest.spyOn(hung, 'analyzeMultiple').mockImplementation(() => new Promise(() => undefined));
    const dispose = jest.spyOn(hung, 'dispose');
    const { handler, findings, logger, metrics } = setup({ analyzerFactory: () => hung });

    await expectJobError(handler.handle(job({ timeoutMs: 20 })), 'ANALYZER_TIMEOUT', true);
    expect(dispose).toHaveBeenCalled();
    expect(findings.list({ organizationId: 'org-a', limit: 100 }).items).toEqual([]);
    expect(logger.lines[0]).toContain('redirect_scan.analyzer_failed');
    expect(metrics.takeSnapshot().analyzerDurations.UnsafeRedirectAnalyzer).toBeGreaterThanOrEqual(0);
  });

  it('turns an analyzer crash into a retryable ANALYZER_FAILED error', async () => {
    const broken = new UnsafeRedirectAnalyzer();
    jest.spyOn(broken, 'analyzeMultiple').mockRejectedValue(new Error('stack overflow near sk_live_abc'));
    const { handler, logger } = setup({ analyzerFactory: () => broken });
    const err = await handler.handle(job()).catch((e) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'ANALYZER_FAILED', retryable: true }));
    expect(err.message).not.toContain('sk_live_abc');
    expect(logger.lines.join('\n')).not.toContain('sk_live_abc');
  });

  it('emits actionable logs and metrics without secrets or file content', async () => {
    const { handler, logger, metrics } = setup();
    const secretFile = [
      'const STRIPE_KEY = "sk_live_51HSecretValue";',
      'const PEM = "-----BEGIN PRIVATE KEY-----MIIEvQIBADANBg";',
      'res.redirect(req.query.token_sk_live_51HSecretValue);',
      "if (url.includes('internal-admin.corp.example')) go();",
    ].join('\n');
    await handler.handle(job({ files: [{ path: 'src/leak.ts', content: secretFile }] }));

    const logs = logger.lines.join('\n');
    expect(logs).not.toMatch(/sk_live|PRIVATE KEY|MIIEv|internal-admin|req\.query/);
    const completed = JSON.parse(logger.lines[logger.lines.length - 1]);
    expect(completed).toEqual(
      expect.objectContaining({
        level: 'info',
        event: 'redirect_scan.completed',
        organizationId: 'org-a',
        repositoryId: 'repo-1',
        analysisJobId: 'job-1',
        status: 'completed',
        findingsByRule: { 'redirect-001': 1, 'redirect-002': 1 },
      }),
    );
    expect(Object.keys(metrics.takeSnapshot().analyzerDurations)).toEqual(['UnsafeRedirectAnalyzer']);
  });
});
