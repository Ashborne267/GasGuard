# Jenkins CI/CD Integration Guide

This guide explains how to integrate GasGuard into a Jenkins CI/CD pipeline for automated smart contract analysis, testing, and security auditing.

---

## Prerequisites

Ensure your Jenkins controller and agent nodes have the following dependencies:

- **Node.js** (v18.x or higher) and npm
- **Git**
- **Rust and Cargo** (required for Soroban smart contract analysis components)
- **Hardhat / Solidity toolchain** (if running EVM contract checks)

Install only the toolchains required by your project.

---

## Declarative Jenkins Pipeline

Create a `Jenkinsfile` in the root of your repository with a pipeline configuration similar to the following:

```groovy
pipeline {
    agent any

    environment {
        NODE_ENV = 'production'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Compile & Lint') {
            steps {
                sh 'npx tsc --noEmit'
            }
        }

        stage('Run Test Suite') {
            steps {
                sh 'npx jest --testPathPattern=config'
            }
        }

        stage('GasGuard Security Analysis') {
            steps {
                withCredentials([
                    string(
                        credentialsId: 'gasguard-api-key',
                        variable: 'GASGUARD_API_KEY'
                    )
                ]) {
                    sh '''
                        mkdir -p reports
                        npx gasguard analyze \
                          --config config/gasguard.config.json \
                          --output reports/audit-report.json
                    '''
                }
            }
        }
    }

    post {
        always {
            archiveArtifacts(
                artifacts: 'reports/**/*',
                allowEmptyArchive: true
            )
        }

        failure {
            echo 'GasGuard CI pipeline failed. Review the build logs and audit findings.'
        }
    }
}
```

**Important:** Adapt the commands to the actual scripts, CLI options, and test configuration supported by your repository. The example assumes that the GasGuard CLI and the specified configuration file exist.

The `npm ci` command requires a committed, compatible `package-lock.json`. If your project uses another package manager, substitute the appropriate installation command.

---

## Credential Management

To configure the API key securely in Jenkins:

1. Navigate to **Manage Jenkins → Credentials**.
2. Select the appropriate credentials store and domain.
3. Add a **Secret text** credential.
4. Set its ID to `gasguard-api-key`.
5. Reference it through the `withCredentials` block in the pipeline.

Never hardcode private keys, mnemonic phrases, API secrets, or other sensitive credentials in the Jenkinsfile or repository.

---

## Troubleshooting and Verification

### Node.js version mismatch

Verify that the Jenkins agent uses the required Node.js version and that `node` and `npm` are available on its `PATH`.

### Missing artifacts

Ensure the build agent can write to the `reports/` directory. Configure test-result publishing separately if your test suite produces JUnit XML files.

### Test results

If your tests generate JUnit XML reports, publish them with:

```groovy
junit testResults: 'test-results/**/*.xml',
      allowEmptyResults: true
```

Place this step in the appropriate `post` block. Do not append `|| true` to the `junit` step; use `allowEmptyResults` when missing reports are expected.

### Local verification

Before running the pipeline, verify the npm scripts, configuration paths, and GasGuard CLI options locally. Jenkins Pipeline Unit can also help test pipeline logic.
