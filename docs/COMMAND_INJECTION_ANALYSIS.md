# Command Injection Analysis

GasGuard's `CommandInjectionAnalyzer` finds OS command injection vulnerabilities
([CWE-78](https://cwe.mitre.org/data/definitions/78.html) and [CWE-88](https://cwe.mitre.org/data/definitions/88.html))
across Node.js / TypeScript and Python codebases. These vulnerabilities occur when external or
user-controlled inputs are passed directly to system shells without escaping or argument separation.

| Layer | Location |
| --- | --- |
| Analyzer (engine) | `libs/engine/analyzers/command-injection/` |
| Worker job + persistence | `apps/api/src/scanner/command-injection-scan.job.ts` |
| Fixtures (representative repos) | `tests/fixtures/command-injection/` |

## Rules

| Rule | Default severity | Detects |
| --- | --- | --- |
| `cmd-001` Unsanitized command execution from user-controlled input | critical | Sinks (`child_process.exec`, `execSync`, `os.system`, `subprocess.Popen`) taking user input without safe escaping. |
| `cmd-002` Dangerous shell execution option enabled | high | Invocation of subprocesses with `shell: true` or `shell=True` enabled on dynamic inputs. |
| `cmd-003` Incomplete command sanitization allows command injection bypass | medium | Naive substring replacements (e.g. only stripping semicolons or spaces) that leave other shell metacharacters (`|`, `&`, `$()`, backticks) unescaped. |
| `cmd-004` Command string constructed via string concatenation or template interpolation | high | Constructing raw command strings via string concatenation or template literals instead of passing arguments as an array to `execFile` or `spawn`. |

## Safe Practices

- Prefer `child_process.execFile` or `child_process.spawn` with `shell: false`, passing arguments as an array:
  ```typescript
  // Safe
  execFile('git', ['status', branchName], (err, stdout) => { ... });
  ```
- In Python, pass arguments as a list without `shell=True`:
  ```python
  # Safe
  subprocess.run(['ping', '-c', '1', host], check=True)
  ```
- If shell invocation is unavoidable, escape user arguments using an established escaping library (such as `shlex.quote` in Python or a dedicated shell quote utility in JavaScript).

## Configuration Options

Configure options under `AnalyzerConfig.options.commandInjection`:
```json
{
  "options": {
    "commandInjection": {
      "safeSanitizers": ["myShellSanitizer"],
      "additionalSinks": ["customExec"],
      "additionalSources": ["event.body.cmd"]
    }
  }
}
```
