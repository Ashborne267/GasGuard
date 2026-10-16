# GasGuard CLI

## Usage

Run `gasguard scan [path]` to scan Solidity, Vyper, and Rust files. Progress is shown only when stderr is a terminal. Use `--no-progress` to disable the spinner, `--quiet` to suppress status output, or `--config <file>` to select a configuration file. Quiet mode keeps errors and command result payloads, including JSON/SARIF reports and AST output.

Create a default configuration with `gasguard init`. Run `gasguard init --interactive` in a terminal to choose include and exclude patterns, report format, summary behavior, confidence threshold, and automatic-fix defaults. Interactive mode requires a TTY; use plain `gasguard init` in scripts. `--force` replaces an existing config.

`gasguard config show` prints the effective configuration. `gasguard config set <key> <value>` edits the selected config file. The root `--config` option applies to scan, init, and config commands.

## Configuration inheritance

Configuration files may specify an `extends` path. Relative paths are resolved from the file declaring `extends`; absolute paths are also accepted.

```json
{
  "extends": "./config/base.json",
  "scan": {
    "exclude": ["vendor/**"]
  }
}
```

Nested objects are merged recursively, while arrays and scalar values in the child replace the parent values. Inheritance chains are supported. Missing parent files, malformed JSON, invalid `extends` values, and cycles are reported as errors.

Scan settings support `include` and `exclude` glob patterns, plus a positive integer `maxFiles`. Output settings support `format` (`text`, `json`, `sarif`, or `both`), `summary`, and `confidenceThreshold` between 0 and 1. Explicit scan flags take precedence over config defaults.

### Backward-compatible config migrations

New configs include `configVersion: 2`. Configs without this field and configs marked version `1` are treated as legacy and migrated in memory when loaded; the CLI does not rewrite the source file. Legacy top-level `includePatterns`, `excludePatterns`, and `outputFormat` are moved to `scan.include`, `scan.exclude`, and `output.format`. Existing nested values take precedence. A non-positive or non-integer schema version, or a version newer than the CLI supports, is rejected with an actionable error. Keep a copy of a config before manually changing its schema.

### Historical report comparison

Save JSON scan reports and compare them with `gasguard compare <baseline.json> <current.json>`. Use `--format json` for a machine-readable comparison or `--output <file>` to write either format to a file. A finding is matched by normalized file path, rule ID, severity, and message; source line movement alone does not count as a new or resolved finding. Both input reports must contain a `findings` array with `file`, `ruleId`, `severity`, and `message` strings on each finding.

### Signed platform builds

Published GitHub releases include standalone CLI executables for Linux x64, macOS x64, macOS arm64, and Windows x64, along with a Sigstore bundle for each executable. Verify a downloaded asset with cosign:

```sh
cosign verify-blob \
  --bundle gasguard-linux-x64.sigstore.json \
  --certificate-identity-regexp 'https://github.com/MDTechLabs/GasGuard/.github/workflows/release-cli.yml@refs/tags/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  gasguard-linux-x64
```

The signing flow uses GitHub Actions OIDC and Sigstore; no signing key is stored in the repository. Release builds depend on the Node.js 20 toolchain, the `@yao-pkg/pkg` packager, GitHub Actions artifact/release services, and Sigstore's OIDC-backed signing services.

## Troubleshooting

- `Interactive setup requires a TTY`: rerun `gasguard init` without `--interactive`, or run it from an interactive terminal.
- `Configuration inheritance cycle detected`: remove the reference that points back to a config already in the inheritance chain.
- `Unsupported configVersion`: upgrade the CLI or change the file to a schema version that the installed CLI supports.
- `Unable to compare reports`: confirm both files are valid JSON scan reports and that every finding has `file`, `ruleId`, `severity`, and `message`.
- Sigstore verification fails: verify the asset and `.sigstore.json` bundle came from the same published release, and use the expected GitHub workflow identity and OIDC issuer.
- `Configuration file not found`: verify the parent path relative to the config that declares it, or correct the `--config` path.
- No progress indicator appears in a script: progress is terminal-only; omit redirection for interactive output or use `--no-progress` to state the intent explicitly.
