# Golden Output Snapshots for Supported Languages

Part of the **Quality and Evaluation** workstream (#1253).

## Overview

GasGuard analyzes multiple smart contract and system languages (e.g., Solidity, Soroban/Rust, Vyper, Cairo, TypeScript). As analyzer rule implementations evolve and rule packs update, non-deterministic outputs, unexpected findings, or regressions in finding categorization can compromise repository scan integrity and cause unpredictable CI/CD outcomes.

The **Golden Output Snapshots** module establishes reproducible, deterministic snapshot evaluation across all supported languages. It captures canonical findings, calculates deterministic fingerprints, validates subsequent repository scan outputs against established golden baselines, and flags regressions or missing findings across language boundaries.

| Component | Location |
| --- | --- |
| Types and Error Codes | `apps/api/src/golden-snapshots/golden-snapshot-types.ts` |
| Configuration (`GOLDEN_SNAPSHOT_*`) | `apps/api/src/golden-snapshots/golden-snapshot-config.ts` |
| Pure Deterministic Evaluator | `apps/api/src/golden-snapshots/golden-snapshot-evaluator.ts` |
| Persistence (InMemory & File) | `apps/api/src/golden-snapshots/golden-snapshot-store.ts` |
| Core Service Boundary | `apps/api/src/golden-snapshots/golden-snapshot.service.ts` |
| Worker Adapter | `apps/api/src/golden-snapshots/golden-snapshot-worker.ts` |
| Metrics and Sanitized Logs | `apps/api/src/golden-snapshots/golden-snapshot-metrics.ts` |
| Fixtures (Realistic Multi-language & Regression) | `apps/api/src/golden-snapshots/__fixtures__/` |

---

## Architectural Principles & Guarantees

### 1. Determinism
- **Canonical Sorting**: Findings within each language are sorted by `file -> startLine -> startColumn -> ruleId -> message`.
- **Deterministic Fingerprinting**: Produces a stable, platform-independent hash across all language outputs for a given commit and rule pack version.
- **Scan Pinning**: Write-once scan pins preserve the exact golden snapshot ID across retries so worker re-executions never compare against altered snapshots.

### 2. Tenant Isolation
- Snapshots, verifications, and pins are strictly partitioned by `tenantId`.
- Both in-memory and disk persistence enforce isolated directory structures (`<baseDir>/<sanitized_tenantId>/...`), preventing data leakages across organizations.

### 3. Multi-Language Coverage
- Supports comparing multiple language outputs within a single repository scan (e.g., Solidity contracts, Soroban Rust pools, and TypeScript frontend scripts).
- Diffs are tracked per language with detailed categorization (`added`, `removed`, `modified`).

---

## Configuration Reference

The following environment variables configure the golden snapshot engine:

| Environment Variable | Default | Purpose |
| --- | --- | --- |
| `GOLDEN_SNAPSHOT_ENABLED` | `true` | Master toggle and kill-switch |
| `GOLDEN_SNAPSHOT_STORAGE_DIR` | `./data/golden-snapshots` | Directory path for filesystem snapshot store |
| `GOLDEN_SNAPSHOT_ENFORCE_MATCHING` | `false` | When `true`, throws errors on snapshot mismatch |
| `GOLDEN_SNAPSHOT_AUTO_UPDATE` | `false` | Automatically creates snapshots if none exist |
| `GOLDEN_SNAPSHOT_MAX_DIFF_COUNT` | `500` | Maximum diffs recorded per language |
| `GOLDEN_SNAPSHOT_MAX_PAYLOAD_SIZE` | `10485760` (10MB) | Maximum snapshot payload size in bytes |

---

## Failure Semantics & Resilience

- **Kill switch**: Setting `GOLDEN_SNAPSHOT_ENABLED=false` bypasses verification gracefully, returning `status: "matched"` with zero overhead.
- **Missing snapshots**: If no golden snapshot exists for a repository and `autoUpdate` is disabled, returns `status: "missing"` without failing scans unless `GOLDEN_SNAPSHOT_ENFORCE_MATCHING=true`.
- **Store unavailability**: Storage read/write errors are classified as `STORE_UNAVAILABLE`, allowing queue retry policies to schedule backoff without corrupting scan outcomes.
- **Log sanitization**: All log events strip tokens, credentials, private keys, passwords, and sensitive payloads.
