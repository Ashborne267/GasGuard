# Container and Image Hardening Guide

## Overview

This document describes the security controls and hardening standards implemented for GasGuard container images and deployment manifests to ensure production readiness, minimal attack surfaces, and compliance with the principle of least privilege.

---

## 1. Minimal Base Images

All application containers utilize minimal Alpine Linux distributions pinned to explicit versions:
- Base image: `node:20.18.0-alpine3.20`
- Package managers and cache artifacts are purged immediately after build steps:
  ```dockerfile
  rm -rf /var/cache/apk/* /tmp/* /root/.npm
  ```
- Development tools, compilers (`g++`, `make`, `python3`), and source files are quarantined strictly to the `builder` stage and omitted from the production `runner` image.

---

## 2. Non-Root Execution

Container processes never execute as the root user (`UID 0`):
- A dedicated unprivileged system account is created with fixed UID/GID:
  - User: `gasguard` (`UID 10001`)
  - Group: `gasguard` (`GID 10001`)
  - Login shell: `/sbin/nologin`
  - Home directory: `/app`
- All application binaries and runtime assets are owned by `gasguard:gasguard`.
- Containers switch to unprivileged execution via `USER gasguard` prior to entrypoint invocation.

---

## 3. Signal Handling and PID 1 Management

- `tini` is installed and declared as the container entrypoint (`ENTRYPOINT ["/sbin/tini", "--"]`).
- This ensures proper reaping of zombie processes and correct propagation of termination signals (`SIGTERM`, `SIGINT`) for graceful zero-downtime shutdowns.

---

## 4. Compose Hardening and Privilege Restrictions

In `docker-compose.yml`, services are configured with defensive security options:
- `security_opt: ["no-new-privileges:true"]`: Prevents child processes from gaining additional privileges via `setuid` or `setgid` binaries.
- Explicit non-root user enforcement (`user: "10001:10001"`).
- Health checks configured with non-root diagnostic commands (`wget --spider`) to continuously report readiness without requiring privileged probing tools.

---

## 5. Automated Vulnerability Scanning

- Container images are automatically scanned via GitHub Actions (`.github/workflows/container-security-scan.yml`) using Trivy.
- The pipeline scans for `CRITICAL` and `HIGH` severity CVEs, generating SARIF reports uploaded directly to GitHub Security Code Scanning.
