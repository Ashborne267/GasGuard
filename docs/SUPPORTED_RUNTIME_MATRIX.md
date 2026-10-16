# Supported Runtime Matrix

GasGuard publishes and tests the CLI against this runtime matrix:

| Component | Supported runtime | Compatibility check |
| --- | --- | --- |
| CLI | Node.js 22 LTS and 24 LTS | `.github/workflows/runtime-compatibility.yml` builds the CLI, runs its tests, and smoke-tests `--help` on both versions. |
| Rust workspace | Rust stable | `rust-toolchain.toml` selects stable; the main CI workflow runs Rust tests on the stable channel. |

Node.js 20 and earlier are not supported for the CLI. CLI package installation declares `engines.node` as `>=22 <25`. The Node matrix is updated when a new even-numbered LTS line becomes supported or an existing line reaches end of support. Rust follows the stable channel rather than promising a fixed minimum supported Rust version.

Runtime compatibility tests depend on the pinned pnpm version in the workflow, the workspace lockfile, and GitHub-hosted Ubuntu runners. The Rust check depends on the Rust stable toolchain and the workspace Cargo manifests.

## Upgrade Compatibility

The CLI config loader accepts unversioned and schema-version-1 config files, migrates legacy top-level `includePatterns`, `excludePatterns`, and `outputFormat` fields in memory, and preserves explicitly configured nested values. New generated files use schema version 2. Loading does not rewrite the original file; future or invalid config versions are rejected. These upgrade cases run in the CLI test suite on both supported Node versions.