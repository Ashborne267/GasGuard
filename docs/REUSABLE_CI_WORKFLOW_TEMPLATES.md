# Reusable CI Workflow Templates

GasGuard provides centralized, reusable GitHub Actions workflows (`workflow_call`) that can be called across repositories or across branches within the same repository to standardize smart contract scanning, quality gates, and artifact policies.

## Available Workflows

### 1. Reusable Scan: `.github/workflows/reusable-gasguard-scan.yml`

Runs the GasGuard static analysis engine against Solidity and Rust smart contracts, generates reports in SARIF/JSON/GitLab formats, and uploads workflow artifacts with compliant retention policies.

#### Inputs

| Input | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `contracts-path` | string | `.` | Directory containing smart contracts to scan |
| `report-format` | string | `sarif` | Output format (`sarif`, `json`, `gitlab`, `text`) |
| `fail-on-severity` | string | `high` | Threshold severity causing the step to fail (`critical`, `high`, `medium`, `low`, `none`) |
| `retention-days` | number | `30` | Duration in days to retain scan report artifacts |
| `upload-artifact` | boolean | `true` | Whether to upload the scan report as a workflow artifact |
| `node-version` | string | `20` | Node.js version runtime |

#### Outputs

| Output | Description |
| :--- | :--- |
| `report-path` | File system path to the generated report |
| `findings-count` | Number of detected issues |

#### Example Usage

In any caller workflow (e.g. `.github/workflows/gasguard.yml`):

```yaml
name: Security & Gas Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  scan:
    uses: MDTechLabs/GasGuard/.github/workflows/reusable-gasguard-scan.yml@main
    with:
      contracts-path: "contracts"
      report-format: "sarif"
      fail-on-severity: "high"
      retention-days: 30
      upload-artifact: true
```

---

### 2. Reusable Quality Gate: `.github/workflows/reusable-quality-gate.yml`

Standardizes pre-merge testing, typechecking, and linting checks.

#### Inputs

| Input | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `node-version` | string | `20` | Node.js version |
| `check-types` | boolean | `true` | Runs `pnpm run build` |
| `check-lint` | boolean | `true` | Runs `pnpm run lint` |
| `run-tests` | boolean | `true` | Runs `pnpm run test` |
| `retention-days` | number | `14` | Artifact retention window |

#### Example Usage

```yaml
jobs:
  quality:
    uses: MDTechLabs/GasGuard/.github/workflows/reusable-quality-gate.yml@main
    with:
      check-types: true
      run-tests: true
```

---

## Organization Starter Templates

The `.github/workflow-templates/` directory provides starter templates for repositories across the organization:
- `gasguard-contract-scan.yml`: Starter template ready to attach to any repository.
- `gasguard-contract-scan.properties.json`: Category, file match patterns, and UI metadata.
