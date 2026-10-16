# GasGuard Configuration Schema Reference

GasGuard uses a centralized JSON configuration file (`config/gasguard.config.json`) alongside programmatic validation modules (`src/config/validator.ts`, `src/config/rule-config-schema.ts`) to manage system behavior, security parameters, analyzer rules, and execution profiles.

---

## 📁 Configuration File Structure

The root configuration schema contains the following top-level properties:

| Property | Type | Description |
| :--- | :--- | :--- |
| `version` | `string` | Configuration schema version (e.g., `"1.0.0"`). |
| `lastUpdated` | `string` (ISO 8601) | Timestamp of the last configuration update. |
| `system` | `object` | Global system settings, logging, performance, security, and feature flags. |
| `rules` | `array` | List of enabled/disabled static analysis and gas optimization rules. |
| `profiles` | `array` | Predefined execution profiles (e.g., `strict-security`, `performance-optimized`). |

---

## ⚙️ 1. System Settings (`system`)

The `system` object configures runtime behavior, resource limits, and feature toggles.

### `system.environment`
* **Type:** `string`
* **Default:** `"development"`
* **Allowed Values:** `"development"`, `"staging"`, `"production"`
* **Description:** Determines the execution environment and loggingverbosity.

### `system.logging`
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `level` | `string` | `"info"` | Logging severity level (`debug`, `info`, `warn`, `error`). |
| `enableConsole` | `boolean` | `true` | Enables console log output. |
| `enableFile` | `boolean` | `true` | Enables persistent file logging. |
| `enableAudit` | `boolean` | `true` | Enables security and action audit logging. |

### `system.performance`
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxConcurrency` | `number` | `4` | Maximum parallel worker threads or tasks. |
| `timeoutMs` | `number` | `30000` | Execution timeout in milliseconds (30s). |
| `enableParallelExecution` | `boolean` | `true` | Toggles parallel execution of independent analysis passes. |

### `system.security`
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enableApiKeyValidation` | `boolean` | `true` | Enforces API key verification for remote calls. |
| `enableRateLimiting` | `boolean` | `true` | Activates rate limiting protection. |
| `maxRequestsPerMinute` | `number` | `100` | Maximum allowed API requests per minute per IP/client. |

### `system.features`
| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enableAutoFix` | `boolean` | `false` | Automatically applies recommended fixes during analysis. |
| `enableDetailedReporting` | `boolean` | `true` | Generates granular reports with line-level metrics. |
| `enableRealTimeMonitoring` | `boolean` | `true` | Enables real-time telemetry and watcher services. |

---

## 🔍 2. Analysis Rules (`rules`)

Each entry in the `rules` array defines an analyzer rule, its severity, target language, and customizable rule parameters.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique rule identifier (e.g., `"unused-state-variables"`, `"reentrancy-guard"`). |
| `name` | `string` | Human-readable rule title. |
| `enabled` | `boolean` | Toggles rule evaluation on or off. |
| `severity` | `string` | Issue severity level (`"low"`, `"medium"`, `"high"`, `"critical"`). |
| `category` | `string` | Domain category (`"soroban"`, `"solidity"`, `"security"`). |
| `language` | `string` | Target smart contract language (`"rust"`, `"solidity"`). |
| `description` | `string` | Detailed explanation of what the rule detects. |
| `parameters` | `object` | Rule-specific tuning parameters (e.g., `ignoreVariables`, `maxSize`). |
| `tags` | `array[string]` | Categorization tags (e.g., `["performance", "security", "gas-optimization"]`). |

---

## 🛡️ 3. Execution Profiles (`profiles`)

Profiles allow you to bundle rule overrides and system adjustments for specific audit scenarios.

* **`strict-security`**: Enforces critical security checks (e.g., `reentrancy-guard`) and restricts rate limits (`maxRequestsPerMinute: 50`).
* **`performance-optimized`**: Focuses on gas efficiency rules (`uint8-vs-uint256`, `unused-state-variables`) and increases worker concurrency (`maxConcurrency: 8`).

---

## 🛠️ Troubleshooting & Validation

If GasGuard fails to start due to configuration errors:
1. Verify that `config/gasguard.config.json` is valid JSON.
2. Run the configuration validation tests to pinpoint schema mismatches:
   ```bash
   npx jest src/config/config-loader.spec.ts

