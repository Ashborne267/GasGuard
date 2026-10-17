import { Language, Severity } from "../../core/analyzer-interface";
import { COMMAND_INJECTION_RULES, CommandInjectionAnalyzer } from "./command-injection-analyzer";
import { CommandInjectionAnalysisMetrics } from "./telemetry";

describe("CommandInjectionAnalyzer", () => {
  let analyzer: CommandInjectionAnalyzer;

  beforeEach(() => {
    analyzer = new CommandInjectionAnalyzer();
  });

  describe("metadata and capabilities", () => {
    it("reports correct name and version", () => {
      expect(analyzer.getName()).toBe("command-injection");
      expect(analyzer.getVersion()).toBe("1.0.0");
    });

    it("supports JS, TS, and Python languages", () => {
      expect(analyzer.supportsLanguage(Language.JAVASCRIPT)).toBe(true);
      expect(analyzer.supportsLanguage(Language.TYPESCRIPT)).toBe(true);
      expect(analyzer.supportsLanguage("js")).toBe(true);
      expect(analyzer.supportsLanguage("ts")).toBe(true);
      expect(analyzer.supportsLanguage("python")).toBe(true);
      expect(analyzer.supportsLanguage("py")).toBe(true);
      expect(analyzer.supportsLanguage("solidity")).toBe(false);
    });

    it("exposes all 4 command injection rules", () => {
      const rules = analyzer.getRules();
      expect(rules).toHaveLength(4);
      const ruleIds = rules.map((r) => r.id);
      expect(ruleIds).toContain(COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(ruleIds).toContain(COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION);
      expect(ruleIds).toContain(COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION);
      expect(ruleIds).toContain(COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION);
    });

    it("can look up a single rule by id", () => {
      const rule = analyzer.getRule(COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe(Severity.CRITICAL);
    });
  });

  describe("Rule cmd-001: Unescaped command execution", () => {
    it("flags exec with request input", async () => {
      const code = `
        import { exec } from 'child_process';
        app.post('/ping', (req, res) => {
          const host = req.body.host;
          exec('ping -c 1 ' + host, (err, stdout) => {
            res.send(stdout);
          });
        });
      `;
      const result = await analyzer.analyze(code, "src/ping.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(f.length).toBeGreaterThan(0);
      expect(f[0].severity).toBe(Severity.CRITICAL);
    });

    it("flags wrapper APIs like runCommand with tainted input", async () => {
      const code = `
        function handleAction(req: any) {
          const cmd = req.query.action;
          runCommand(cmd);
        }
      `;
      const result = await analyzer.analyze(code, "src/action.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(f.length).toBeGreaterThan(0);
    });

    it("flags Python os.system with request.args", async () => {
      const code = `
        @app.route('/exec')
        def run_os():
            user_cmd = request.args.get('cmd')
            os.system(user_cmd)
      `;
      const result = await analyzer.analyze(code, "app.py");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(f.length).toBeGreaterThan(0);
    });

    it("does not flag exec when safe sanitizer is used in proximity", async () => {
      const code = `
        import { exec } from 'child_process';
        app.post('/ping', (req, res) => {
          const host = req.body.host;
          const safeHost = escapeShellArg(host);
          exec('ping -c 1 ' + safeHost, (err, stdout) => {
            res.send(stdout);
          });
        });
      `;
      const result = await analyzer.analyze(code, "src/ping.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION);
      expect(f.length).toBe(0);
    });
  });

  describe("Rule cmd-002: Dangerous shell option", () => {
    it("flags shell: true in spawn", async () => {
      const code = `
        const child = spawn('npm', ['test'], {
          shell: true
        });
      `;
      const result = await analyzer.analyze(code, "src/runner.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION);
      expect(f.length).toBeGreaterThan(0);
      expect(f[0].severity).toBe(Severity.HIGH);
    });

    it("flags shell=True in Python subprocess", async () => {
      const code = `
        subprocess.Popen(['ls', '-la'], shell=True)
      `;
      const result = await analyzer.analyze(code, "runner.py");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION);
      expect(f.length).toBeGreaterThan(0);
    });
  });

  describe("Rule cmd-003: Incomplete sanitization", () => {
    it("flags naive .replace(/;/g, '')", async () => {
      const code = `
        function sanitize(cmd: string) {
          return cmd.replace(/;/g, '');
        }
      `;
      const result = await analyzer.analyze(code, "src/sanitizer.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION);
      expect(f.length).toBeGreaterThan(0);
      expect(f[0].severity).toBe(Severity.MEDIUM);
    });
  });

  describe("Rule cmd-004: Dynamic command concatenation", () => {
    it("flags command built with template literal", async () => {
      const code = `
        function executeBackup(targetFile: string) {
          exec(\`tar -czf backup.tar.gz \${targetFile}\`);
        }
      `;
      const result = await analyzer.analyze(code, "src/backup.ts");
      const f = result.findings.filter((x) => x.ruleId === COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION);
      expect(f.length).toBeGreaterThan(0);
      expect(f[0].severity).toBe(Severity.HIGH);
    });
  });

  describe("metrics observer and edge cases", () => {
    it("records metrics via observer", async () => {
      const metrics = new CommandInjectionAnalysisMetrics();
      const obsAnalyzer = new CommandInjectionAnalyzer({ observer: metrics });

      await obsAnalyzer.analyze("exec('ping ' + userInput);", "test.ts");

      const snapshot = metrics.snapshot();
      expect(snapshot.filesAnalyzed).toBe(1);
      expect(snapshot.totalFindings).toBeGreaterThan(0);
    });

    it("skips declaration files", async () => {
      const result = await analyzer.analyze("declare function exec(cmd: string): void;", "types.d.ts");
      expect(result.filesAnalyzed).toBe(0);
      expect(result.findings).toHaveLength(0);
    });
  });
});
