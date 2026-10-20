# GitLab CI Integration & Output Format

GasGuard supports the native [GitLab CI Code Quality format](https://docs.gitlab.com/ee/ci/testing/code_quality.html#implement-a-custom-tool), enabling findings to be displayed directly in GitLab Merge Request widgets, pipeline Code Quality tabs, and security dashboards.

## Generating GitLab Code Quality Reports

Run the scan command specifying `--format gitlab`:

```bash
# Via apps/cli
node dist/apps/cli/src/commands/scan.js contracts --format gitlab -o gl-code-quality-report.json

# Via packages/cli
gasguard scan contracts --format gitlab -o gl-code-quality-report.json
```

## `.gitlab-ci.yml` Pipeline Configuration

Include GasGuard in your GitLab CI pipeline and declare the report artifact under `artifacts:reports:codequality`:

```yaml
stages:
  - test
  - gas-analysis

gasguard-code-quality:
  stage: gas-analysis
  image: node:20
  before_script:
    - npm install -g pnpm
    - pnpm install --frozen-lockfile
    - pnpm run build
  script:
    - node dist/apps/cli/src/commands/scan.js contracts/ --format gitlab -o gl-code-quality-report.json
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
    expire_in: 30 days
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

## Report Schema & Severity Mapping

GasGuard maps rule matches to the GitLab Code Quality JSON schema:

| GasGuard Severity | GitLab Severity | Description |
| :--- | :--- | :--- |
| `critical` | `critical` | Critical vulnerability or major gas exploit |
| `high` | `major` | High severity finding or major gas regression |
| `medium` | `minor` | Moderate gas savings opportunity |
| `low` / `info` | `info` | Informational optimization or style hint |

### Example Issue Object

```json
[
  {
    "description": "[GAS-001] storage-caching: State variable read multiple times in loop",
    "check_name": "GAS-001",
    "fingerprint": "a3f5b08c90b8f...",
    "severity": "major",
    "location": {
      "path": "contracts/Vault.sol",
      "lines": {
        "begin": 42
      }
    },
    "categories": [
      "Gas Optimization",
      "Security"
    ],
    "engine_name": "GasGuard",
    "content": {
      "body": "Estimated gas savings: 450 units"
    }
  }
]
```

### Deterministic Fingerprinting

Every finding receives a deterministic SHA-256 fingerprint generated from:
```
${ruleId}:${normalizedFilePath}:${line}:${column}:${message}
```
This guarantees that GitLab CI tracks resolving and regressing findings across merge requests without generating duplicate issues.
