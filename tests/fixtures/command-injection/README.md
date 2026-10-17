# Command Injection Analyzer Fixtures

Fixtures demonstrating detection of Command Injection weaknesses (CWE-78):
- Direct and wrapper command sinks (`child_process.exec`, `os.system`, `subprocess.Popen`)
- Dynamic shell execution (`shell: true`, `shell=True`)
- Naive sanitization bypasses
- Hardcoded command concatenation vs. safe execFile argument arrays
