# Alerting for Repeated Parser Failures

## Overview

Issue #1262 introduces automated alerting and failure tracking for repeated Solidity, Vyper, and Soroban AST parser failures across analyzed repositories.

When repository commits introduce unsupported syntax, compiler version mismatches, or parser worker panics, alerting platform maintainers early prevents silently corrupted scan batches and unanalyzed contracts.

## Key Capabilities

- **Deterministic Evaluation**: Evaluates repository scan records monotonically and deterministically, guaranteed to produce identical alert states for identical inputs and clock sequences.
- **Tenant Isolation**: Failure counts, sliding windows, and active alerts are strictly scoped to `(tenantId, repositoryUrl, language)`. Cross-tenant state leakage is impossible.
- **Configurable Alert Thresholds**:
  - `consecutiveFailuresThreshold`: Triggers an alert when consecutive scans fail parsing (default `3`).
  - `failureRatioThreshold`: Triggers an alert when the ratio of failures in the sliding window exceeds the threshold (default `0.4` or 40%).
  - `windowSize`: Number of historical scans tracked in memory per repository (default `10`).
  - `cooldownPeriodMs`: Alert deduplication window to suppress notification floods (default `300,000ms` / 5 minutes).
  - `autoResolveConsecutiveSuccesses`: Automatically transitions alerts from `active` to `resolved` once consecutive parses succeed (default `2`).
- **Zero Code Leakage**: Aggregates structured diagnostic codes (e.g. `unexpected_token`, `recursion_limit_exceeded`) without storing or logging contract source code or private keys.
- **Severity Escalation**: Distinguishes between `warning` and `critical` severity based on consecutive failure depth.

## Alert Lifecycle

```
  Scans fail repeatedly
  -----------------------> [ ACTIVE ALERT ] (warning)
                               |
                               | Further failures beyond cooldown
                               v
                           [ ACTIVE ALERT ] (critical)
                               |
                               | Consecutive successes >= autoResolveConsecutiveSuccesses
                               v
                           [ RESOLVED ]
```

## Example Usage

```typescript
import { ParserFailureAlertService } from "./scanner/parser-alerting";

const alertService = new ParserFailureAlertService({
  consecutiveFailuresThreshold: 3,
  autoResolveConsecutiveSuccesses: 2,
  cooldownPeriodMs: 5 * 60 * 1000,
});

// Register notification sink (e.g. Slack webhook, PagerDuty, Prometheus)
alertService.registerHandler({
  onAlert: async (alert) => {
    if (alert.status === "active") {
      console.warn(`[ALERT] Parser failure on ${alert.repositoryUrl}: ${alert.triggerReason}`);
    } else if (alert.status === "resolved") {
      console.log(`[RESOLVED] Parser health restored on ${alert.repositoryUrl}`);
    }
  },
});

// Record scan outcomes during background worker execution
await alertService.recordScan({
  scanId: "scan-1234",
  tenantId: "tenant-acme",
  repositoryUrl: "https://github.com/acme/defi-contracts",
  commitHash: "e4f1a2b",
  language: "solidity",
  parserName: "solidity-ast-parser-v2",
  timestamp: Date.now(),
  hasFailed: true,
  failureCategory: "syntax_error",
  diagnosticCodes: ["unexpected_token", "invalid_pragma"],
  errorSummary: "Unsupported transient storage opcode",
});
```
