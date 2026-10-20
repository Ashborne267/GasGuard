# Track Rule Performance Regression Thresholds

Part of the **Quality and Evaluation** workstream (#1251).

## Overview

GasGuard executes static analysis and optimization rules against smart contracts and multi-language repositories. As rules evolve and rule packs update, regressions in execution time, memory footprint, or failure/timeout rates can degrade repository scan performance and impact CI/CD pipelines.

The **Rule Performance Regression Thresholds** module provides automated, deterministic tracking of rule execution performance across repository scans and rule-pack versions. It detects metric degradation compared to established baselines, alerts operators through structured metrics, and enforces quality gates before regressions reach production.

| Component | Location |
| --- | --- |
| Types and Error Codes | `apps/api/src/rules/performance-regression/rule-performance-types.ts` |
| Configuration (`RULE_PERFORMANCE_*`) | `apps/api/src/rules/performance-regression/rule-performance-config.ts` |
| Pure Deterministic Evaluator | `apps/api/src/rules/performance-regression/rule-performance-evaluator.ts` |
| Persistence (InMemory & File) | `apps/api/src/rules/performance-regression/rule-performance-store.ts` |
| Core Service Boundary | `apps/api/src/rules/performance-regression/rule-performance.service.ts` |
| Worker Adapter | `apps/api/src/rules/performance-regression/rule-performance-worker.ts` |
| Metrics and Structured Logs | `apps/api/src/rules/performance-regression/rule-performance-metrics.ts` |
| Fixtures (Realistic Repo & Regression) | `apps/api/src/rules/performance-regression/__fixtures__/` |

---

## Architectural Principles & Design

### 1. Determinism
- **Pure evaluation**: Given identical rule execution samples, baseline metrics, and configuration thresholds, the evaluator produces identical results (`passed`, `warning`, `breached`) and an identical djb2 fingerprint.
- **Scan Pinning**: Write-once scan pins store the exact evaluation parameters per `(tenantId, scanId)`. Retry attempts always reuse the established pin so transient worker restarts do not alter baseline comparison refs.

### 2. Tenant Isolation
- Baselines, evaluations, and scan pins are strictly partitioned by `tenantId`.
- Both in-memory and disk persistence enforce isolated directory structures (`<baseDir>/<sanitized_tenantId>/...`), preventing data leakages across organizations.

### 3. Metric Thresholds & Regression Math
Rules are evaluated against absolute ceilings as well as relative delta percentages against baseline records:
- **Duration (Execution time)**:
  - Absolute threshold: `maxDurationMs` (default: 5,000ms)
  - Relative regression: `maxDurationDeltaPercent` (default: +50% regression)
- **Memory Consumption**:
  - Absolute threshold: `maxMemoryBytes` (default: 256MB)
  - Relative regression: `maxMemoryDeltaPercent` (default: +50% regression)
- **Error / Timeout Rate**:
  - Maximum ratio of non-ok executions: `maxErrorRate` (default: 0.05 / 5%)
- **Early Warnings**:
  - Warning threshold factor: `warningFactor` (default: 0.8 / 80% of breach limit)

---

## Configuration Reference

Environment variables configure the default limits and behaviors:

| Environment Variable | Default | Purpose |
| --- | --- | --- |
| `RULE_PERFORMANCE_TRACKING_ENABLED` | `true` | Master toggle and kill-switch |
| `RULE_PERFORMANCE_DEFAULT_MAX_DURATION_MS` | `5000` | Absolute duration limit in ms |
| `RULE_PERFORMANCE_DEFAULT_MAX_DURATION_DELTA_PERCENT` | `50` | Maximum allowed duration increase |
| `RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_BYTES` | `268435456` | Absolute memory limit (256MB) |
| `RULE_PERFORMANCE_DEFAULT_MAX_MEMORY_DELTA_PERCENT` | `50` | Maximum allowed memory increase |
| `RULE_PERFORMANCE_DEFAULT_MAX_ERROR_RATE` | `0.05` | Maximum allowed failure ratio |
| `RULE_PERFORMANCE_WARNING_FACTOR` | `0.8` | Ratio of threshold triggering warning |
| `RULE_PERFORMANCE_MAX_SAMPLES_PER_RULE` | `1000` | Max samples stored per rule |
| `RULE_PERFORMANCE_BASELINE_RETENTION_MS` | `2592000000` | Retention window for baseline records (30 days) |

---

## Failure Semantics & Resilience

- **Kill switch**: Setting `RULE_PERFORMANCE_TRACKING_ENABLED=false` bypasses all regression checks gracefully, returning `status: "passed"` with zero overhead.
- **Partial rule failure**: If a specific rule throws or times out during worker execution, the worker isolates the failure, records status `"error"`, and continues executing the remainder of the rule-pack.
- **Store unavailability**: Storage read/write errors are classified as `STORE_UNAVAILABLE`, allowing queue retry policies to schedule backoff without corrupting scan outcomes.
- **Log sanitization**: All log events strip tokens, credentials, private keys, passwords, and file paths.
