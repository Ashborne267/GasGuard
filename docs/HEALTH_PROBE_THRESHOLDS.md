# Configurable Health Probe Thresholds

## Overview

Issue #1266 introduces configurable health probe evaluation across GasGuard's subsystems (RPC nodes, Redis connection pools, background worker pools, and AST analyzer workers).

Instead of treating endpoints with binary alive/dead checks or fixed timeouts, the health probe system distinguishes between **Healthy**, **Degraded**, and **Unhealthy** states based on tunable latency thresholds, consecutive failure/success counts, and sliding window failure rates.

## Configuration Surface

The configuration interface `HealthProbeThresholds` supports:

| Property | Type | Default | Description |
|---|---|---|---|
| `healthyLatencyMsThreshold` | `number` | `500` | Latency (ms) below which response is healthy |
| `degradedLatencyMsThreshold` | `number` | `1500` | Latency (ms) above which status becomes degraded |
| `unhealthyLatencyMsThreshold` | `number` | `5000` | Latency (ms) above which status becomes unhealthy |
| `consecutiveFailuresThreshold` | `number` | `3` | Consecutive failures required before declaring unhealthy |
| `consecutiveSuccessesThreshold` | `number` | `2` | Consecutive successes required to recover to healthy |
| `failureRateDegradedThreshold` | `number` | `0.2` (20%) | Failure rate in window triggering degraded status |
| `failureRateUnhealthyThreshold` | `number` | `0.5` (50%) | Failure rate in window triggering unhealthy status |
| `timeoutMs` | `number` | `5000` | Probe timeout in milliseconds |
| `windowSize` | `number` | `20` | Bounded sliding window size for historical metrics |
| `minSamplesForFailureRate` | `number` | `5` | Minimum samples before evaluating sliding failure rate |

## State Transition Semantics

```
  +--------------+  1 failure or high latency   +--------------+
  |              | ---------------------------> |              |
  |   HEALTHY    |                              |   DEGRADED   |
  |              | <--------------------------- |              |
  +--------------+   consecutive successes >= N +--------------+
        |                                              |
        |                                              | consecutive failures >= M
        |                                              | or failure rate >= 50%
        |                                              v
        |                                       +--------------+
        |                                       |              |
        +-------------------------------------> |  UNHEALTHY   |
            severe latency or critical errors   |              |
                                                +--------------+
```

1. **Degraded State**:
   - Triggered when latency exceeds `degradedLatencyMsThreshold`.
   - Triggered when a single failure occurs (`consecutiveFailures > 0` but `< consecutiveFailuresThreshold`).
   - Triggered when sliding window failure rate exceeds `failureRateDegradedThreshold`.
   - Transient state during recovery when successes occur but haven't reached `consecutiveSuccessesThreshold`.

2. **Unhealthy State**:
   - Triggered when consecutive failures reach `consecutiveFailuresThreshold`.
   - Triggered when sliding window failure rate reaches `failureRateUnhealthyThreshold`.
   - Triggered when latency exceeds `unhealthyLatencyMsThreshold`.

3. **Recovery to Healthy**:
   - Requires `consecutiveSuccessesThreshold` consecutive successful samples with latency within healthy bounds.

## Privacy & Security

Target endpoints, URLs, error messages, and logs are automatically sanitized via `sanitizeProbeTarget`:
- Authentication tokens (`api_key`, `token`, `secret`, `password`) are redacted.
- Basic authentication credentials in URLs (`https://user:password@node/rpc`) are scrubbed before storage and display.

## Example Usage

```typescript
import { HealthProbeRegistry, HealthCheckService } from "@monitoring";

const registry = new HealthProbeRegistry();
const rpcProbe = registry.registerProbe("alchemy-polygon", {
  healthyLatencyMsThreshold: 200,
  degradedLatencyMsThreshold: 800,
  unhealthyLatencyMsThreshold: 2500,
  consecutiveFailuresThreshold: 3,
  consecutiveSuccessesThreshold: 2,
});

// Record probe execution
await rpcProbe.executeProbe(async () => {
  const res = await callNodeHealth();
  return { latencyMs: res.elapsedMs };
});

const evalReport = rpcProbe.evaluate();
console.log(evalReport.status); // "healthy" | "degraded" | "unhealthy"
```
