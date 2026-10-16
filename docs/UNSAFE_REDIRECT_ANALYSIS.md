# Unsafe Redirect Validation Analysis

GasGuard's `UnsafeRedirectAnalyzer` finds open-redirect weaknesses
([CWE-601](https://cwe.mitre.org/data/definitions/601.html)) in the
JavaScript/TypeScript parts of a repository. These include dApp front-ends,
wallet-connect callbacks, OAuth/SSO handlers and API gateways. It reports
redirects that use request-controlled input without validation, and
validation that looks protective but can be bypassed.

| Layer | Location |
| --- | --- |
| Analyzer (engine) | `libs/engine/analyzers/unsafe-redirect/` |
| Worker job + persistence | `apps/api/src/scanner/redirect-scan.job.ts` |
| Fixtures (representative repos) | `tests/fixtures/unsafe-redirect/` |

## Rules

| Rule | Default severity | Detects |
| --- | --- | --- |
| `redirect-001` Unvalidated Redirect Target | high | A redirect or navigation target that comes from request input with no allowlist guard. Also flags Express `res.redirect("back")`, which redirects to the `Referer` header. |
| `redirect-002` Bypassable Redirect Host Check | medium | `startsWith("https://trusted.example")` with no path boundary, scheme-only `startsWith("https://")`, `endsWith("trusted.example")` with no leading dot, and `includes`/`indexOf` substring host checks. |
| `redirect-003` Relative Redirect Check Allows Protocol-Relative URLs | medium | `x.startsWith("/")`, `x[0] === "/"` or `x.charAt(0) === "/"` without a nearby `//` or `/\` rejection. |
| `redirect-004` Bypassable Redirect Allowlist Regex | medium | Host allowlist regexes with no `^`, a wildcard before the host, unescaped `.` in the host, or a host not terminated by `$`, `/` or `:`. |

Every finding carries `metadata.cwe = "CWE-601"`, plus `sinkKind` and
`sourceKind` (rule 001), `method` and `reason` (rules 002 and 003), or
`reasons[]` (rule 004).

### Sources (request-controlled input)

- `req|request|ctx|ctx.request|event` `.query`, `.body`, `.params`, `.cookies`,
  `.headers`, `.queryStringParameters`
- the Referer header: `req.headers.referer`, `req.get("referer")`, `req.header("referer")`
- `searchParams.get(...)`, `query.get(...)`, `params.get(...)` (including
  `request.nextUrl.searchParams`)
- `router.query`, `location.search`, `location.hash`, `document.referrer`,
  `document.URL`, `window.name`
- anything listed in `additionalSources`

### Sinks

- `res|response|reply|ctx|h|NextResponse|Response .redirect(...)`. For the
  numeric status-code form, the URL is the last argument.
- framework `redirect(...)` helpers (Next.js, Remix). Method declarations are ignored.
- `setHeader|set|header|append("Location", ...)` and `writeHead(30x, { Location })`
- `location = ...`, `location.href = ...`, `location.assign|replace(...)`, `window.open(...)`
- anything listed in `additionalSinks`

### What counts as validation

A tainted value is treated as validated (no `redirect-001`) when, within
`proximityLines` before the sink, one of these appears:

- a call to a configured or default safe validator that takes the value
  (`isSafeRedirect`, `safeRedirect`, `validateRedirect`, `isRelativeUrl`, …;
  see `DEFAULT_SAFE_VALIDATORS`);
- an allowlist lookup such as `ALLOWED.includes(...)` or `ALLOWED_HOSTS.has(url.host)`;
- an exact `host`, `hostname` or `origin` comparison on the value or on a URL
  derived from it.

If the only guard is a weak check (rules 002 to 004), the weak check is
reported and `redirect-001` is suppressed. That way one bug produces one
finding.

A target that starts with a fixed origin is never tainted: either a relative
path such as `"/welcome?ref=" + x`, or an absolute origin followed by `/`, `?`
or `#`, such as `` `https://docs.example.com/${x}` ``.

## Configuration

All options are optional. Leaving out `options.unsafeRedirect` gives the
defaults, so existing configurations are unaffected.

```jsonc
{
  "rules": {
    "redirect-003": false,                                    // disable a rule
    "redirect-001": { "enabled": true, "severity": "critical" } // override severity
  },
  "excludePaths": ["**/__mocks__/**"],
  "maxFindings": 500,
  "options": {
    "unsafeRedirect": {
      "safeValidators": ["assertSameOrigin"],     // identifiers; merged with defaults
      "additionalSinks": ["h.redirect"],          // dotted call names, first argument is the target
      "additionalSources": ["event.multiValueQueryStringParameters"], // dotted member paths
      "proximityLines": 25,                       // 1-500, default 25
      "maxFileBytes": 1000000                     // 1-50,000,000, default 1,000,000 (UTF-8 bytes)
    }
  }
}
```

Validation is strict. Unknown rule ids, unknown option keys, bad severities,
non-identifier names and out-of-range integers all fail `validateConfig()`.
`analyze` and `analyzeMultiple` throw `Invalid configuration: …`, which the
engine's safe runner turns into an `error` diagnostic.

## Supported input and runtimes

| Item | Support |
| --- | --- |
| File types | `.js .jsx .mjs .cjs .ts .tsx .mts .cts`. `.d.ts`, `.d.mts` and `.d.cts` files are skipped. |
| Frameworks covered by fixtures | Express 4/5, Koa 2, Fastify 4/5, Next.js 13+ (App Router, middleware, client components), Node `http` |
| Node.js | 20.x (the CI version, see `.github/workflows/ci.yml`). Requires ES2018+ regex lookbehind, so Node ≥ 10 at runtime. |
| Dependencies | None. The analyzer is lexical and needs no parser. |

### Unsupported or invalid input

| Input | `analyze()` | `analyzeMultiple()` |
| --- | --- | --- |
| Unsupported extension (`.sol`, `.rs`, none) | no findings, `errors[]` entry "unsupported file type" | skipped silently, counted in telemetry (`unsupported-file-type`) |
| Declaration file | skipped silently | skipped silently (`declaration-file`) |
| Excluded by `excludePaths`/`includePaths`/`changedFilesOnly` | skipped silently | skipped silently |
| Larger than `maxFileBytes` | `errors[]` entry; other files continue | same |
| Contains NUL bytes (binary) | `errors[]` entry | same |
| Non-string content or empty path | `errors[]` entry ("invalid input") | same |
| Non-`Map` argument | — | throws `TypeError` |
| Unterminated strings or comments | analyzed best-effort; never throws | same |

### Determinism

Findings are de-duplicated per `(rule, line, column)` and sorted by file,
line, column and rule id. Results do not depend on the order of the input
`Map` or on earlier runs. The incremental cache is keyed by content hash and
returns identical findings.

### Known limitations

- Taint tracking is per file and ignores scope. Values passed across modules
  or through function parameters are not followed. A variable reassigned to a
  clean value is untainted for the rest of the file.
- A guard counts if it mentions the value within `proximityLines`. Whether it
  actually controls the redirect branch is not checked.
- Rules 002 to 004 need a receiver or argument that looks URL-related (a
  tainted name, a request source, or a name containing
  `url`/`redirect`/`next`/`return`/`target`/`host`/…). This keeps
  `fileName.endsWith(".com")` and similar code quiet.

## Worker job

`RedirectScanJobHandler.handle(payload)` is the API/worker boundary. The
handler is framework-agnostic. Register it under the job name
`security.unsafe-redirect` in the queue processor.

```ts
interface RedirectScanJobPayload {
  schemaVersion?: 1;            // omitted = 1; other values rejected
  organizationId: string;       // tenant boundary; ≤256 chars, no control chars
  repositoryId: string;
  analysisJobId: string;
  files: { path: string; content: string }[]; // ≤5000, unique paths
  config?: { rules?; excludePaths?; includePaths?; maxFindings?; options? };
  timeoutMs?: number;           // 1..600000, default engine budget (30s)
}
```

### Tenant isolation

- Each job builds a new analyzer via `analyzerFactory`, so no file cache or
  analyzer state is shared between jobs or tenants.
- Findings are written with the payload's `organizationId` and
  `repositoryId` only. Idempotency lookups go through the tenant-scoped
  `FindingsService.list`, so a retry in one tenant never deduplicates against
  another tenant's data.

### Failure semantics

| Condition | Result | `retryable` |
| --- | --- | --- |
| Invalid payload | `RedirectScanJobError("INVALID_JOB")` | `false` |
| Invalid analyzer config | `RedirectScanJobError("INVALID_CONFIG")` | `false` |
| Analyzer exceeds `timeoutMs` | `RedirectScanJobError("ANALYZER_TIMEOUT")`; nothing persisted | `true` |
| Analyzer throws | `RedirectScanJobError("ANALYZER_FAILED")`; nothing persisted; the original message is not propagated | `true` |
| Findings store throws | `RedirectScanJobError("PERSISTENCE_FAILED")` | `true` |
| Some files too large, binary or invalid | `status: "partial"` with `fileErrors[]`; the other files' findings persist | n/a |

Map `retryable: false` to BullMQ's `UnrecoverableError` so these jobs go
straight to the dead-letter queue instead of using up their retry budget
(`apps/api/src/queue/retry.ts`).

**Retries are idempotent.** A finding is keyed on
`(rule, file, line, title)` within the `(organization, repository,
analysisJobId)` scope. A retry after a partial persistence failure writes only
the missing findings. A new `analysisJobId` is a new run, and its findings link
to earlier runs through the existing fingerprint (`firstSeenAt`,
`occurrenceCount`).

### Logs and metrics

| Event | Level | Fields |
| --- | --- | --- |
| `redirect_scan.completed` | info | ids, `status`, `analyzerVersion`, `filesReceived/Analyzed/Skipped`, `skippedByReason`, `fileErrorCount`, `findingsDetected/Persisted/AlreadyPersisted`, `findingsByRule`, `durationMs` |
| `redirect_scan.analyzer_failed` | warn | ids, `kind` (`timeout`/`error`), `elapsedMs`, `timeoutMs`, `fileCount` |
| `redirect_scan.persistence_failed` | warn | ids, `findingsDetected` |
| `redirect_scan.rejected` | warn | ids, `code`, `errorCount` |

`MetricsCollector.recordAnalyzerDuration("UnsafeRedirectAnalyzer", ms)` is
recorded for every attempt. Inside the engine, `RedirectAnalysisMetrics` (an
`observer`) counts analyzed and skipped files by reason, plus findings per
rule.

Logs, metrics and finding messages never contain file content, redirect
targets, matched literals or downstream exception messages. Tests check this
with embedded API keys, PEM private keys, credentialed connection strings and
internal hostnames.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm jest libs/engine/analyzers/unsafe-redirect apps/api/src/scanner/redirect-scan.job.spec.ts
```

| Suite | Covers |
| --- | --- |
| `unsafe-redirect-analyzer.spec.ts` | Each rule's positive and negative cases, config validation, boundaries (`maxFileBytes`, `proximityLines`, `maxFindings`), invalid input, determinism, telemetry |
| `lexer.spec.ts` | Comment masking, argument and expression reading, offset mapping |
| `unsafe-redirect.repositories.spec.ts` | The four fixture repositories (exact expected findings), registry selection, safe-runner timeout and error diagnostics |
| `redirect-scan.job.spec.ts` | Persistence, tenant isolation, retry idempotency, partial failure, every error code, log and metric redaction |
