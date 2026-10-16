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

New config files use `configVersion: 2`. Unversioned and version-1 configs are migrated in memory; legacy `includePatterns`, `excludePatterns`, and `outputFormat` keys move to `scan.include`, `scan.exclude`, and `output.format`. Existing nested settings take precedence. Config files are never rewritten automatically, and unsupported future versions fail with an error.

## Remediation Backlog

Export findings from a JSON scan report as an actionable backlog:

```sh
gasguard backlog report.json --format csv --output remediation.csv
```

Supported formats are CSV (default), JSON, and Markdown. Without `--output`, the export is written to stdout. Items are sorted by severity, receive a deterministic ID and `open` status, and include source location, rule, message, suggestion, and optional gas-savings/confidence data. CSV cells are quoted and formula-prefixed values are escaped for spreadsheet safety. The input must be a GasGuard JSON scan report containing a `findings` array.

See [Supported Runtime Matrix](../../docs/SUPPORTED_RUNTIME_MATRIX.md) for tested Node.js and Rust versions, and [Release Artifact Retention Policy](../../docs/RELEASE_ARTIFACT_POLICY.md) for artifact lifetime and recovery.

## Troubleshooting

- `Interactive setup requires a TTY`: rerun `gasguard init` without `--interactive`, or run it from an interactive terminal.
- `Configuration inheritance cycle detected`: remove the reference that points back to a config already in the inheritance chain.
- `Configuration file not found`: verify the parent path relative to the config that declares it, or correct the `--config` path.
- `Unsupported configVersion`: upgrade the CLI or migrate the file to a supported schema version.
- `Unable to export remediation backlog`: check that the input is valid JSON with a `findings` array and that the output directory is writable.
- No progress indicator appears in a script: progress is terminal-only; omit redirection for interactive output or use `--no-progress` to state the intent explicitly.
