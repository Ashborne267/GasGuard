import {
  AnalyzerCapabilities,
  AnalysisResult,
  AnalyzerConfig,
  BaseAnalyzer,
  Finding,
  Language,
  Rule,
  Severity,
} from "../../core/analyzer-interface";
import {
  fileExtension,
  isDeclarationFile,
  isSupportedCommandFile,
  resolveCommandInjectionOptions,
  ResolvedCommandInjectionOptions,
  COMMAND_INJECTION_OPTIONS_KEY,
  CommandInjectionOptions,
  validateCommandInjectionOptions,
} from "./config";
import {
  escapeRegExp,
  LineIndex,
  maskComments,
  readCallArgs,
} from "./lexer";
import {
  notifySafely,
  CommandInjectionAnalysisObserver,
  CommandInjectionSkipReason,
} from "./telemetry";

export const COMMAND_INJECTION_RULES = {
  UNESCAPED_EXECUTION: "cmd-001",
  DANGEROUS_SHELL_OPTION: "cmd-002",
  INCOMPLETE_SANITIZATION: "cmd-003",
  DYNAMIC_CONCATENATION: "cmd-004",
} as const;

interface SourcePattern {
  kind: string;
  re: RegExp;
}

const BUILTIN_SOURCES: SourcePattern[] = [
  {
    kind: "request-input",
    re: /\b(?:req|request|ctx\.request|ctx|event)\s*\.\s*(?:query|body|params|headers|queryStringParameters)\b/,
  },
  {
    kind: "process-argv",
    re: /\bprocess\s*\.\s*argv\b/,
  },
  {
    kind: "python-request",
    re: /\b(?:request\s*\.\s*(?:args|form|values|json|data|GET|POST)|sys\s*\.\s*argv)\b/,
  },
];

const RULES: readonly Rule[] = [
  {
    id: COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION,
    name: "Unsanitized command execution from user-controlled input",
    description:
      "Executes a system shell command with arguments derived from untrusted user input without shell escaping, risking OS Command Injection (CWE-78).",
    severity: Severity.CRITICAL,
    category: "security",
    enabled: true,
    tags: ["security", "cwe-78", "command-injection"],
    documentationUrl: "https://cwe.mitre.org/data/definitions/78.html",
  },
  {
    id: COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION,
    name: "Dangerous shell execution option enabled",
    description:
      "Spawns processes with shell: true or shell=True enabled, which interprets shell metacharacters and allows command injection.",
    severity: Severity.HIGH,
    category: "security",
    enabled: true,
    tags: ["security", "cwe-78", "shell-escape"],
    documentationUrl: "https://cwe.mitre.org/data/definitions/78.html",
  },
  {
    id: COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION,
    name: "Incomplete command sanitization allows command injection bypass",
    description:
      "Attempts to sanitize shell arguments using naive substring or character replacement (e.g. only stripping semicolons or ampersands) that can be easily bypassed.",
    severity: Severity.MEDIUM,
    category: "security",
    enabled: true,
    tags: ["security", "cwe-78", "sanitization-bypass"],
    documentationUrl: "https://cwe.mitre.org/data/definitions/78.html",
  },
  {
    id: COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION,
    name: "Command string constructed via string concatenation or template interpolation",
    description:
      "Constructs a command string using string concatenation or template literals rather than passing arguments as an array to spawn/execFile.",
    severity: Severity.HIGH,
    category: "security",
    enabled: true,
    tags: ["security", "cwe-78", "concatenation"],
    documentationUrl: "https://cwe.mitre.org/data/definitions/78.html",
  },
];

export interface CommandInjectionAnalyzerOptions {
  observer?: CommandInjectionAnalysisObserver;
}

export class CommandInjectionAnalyzer extends BaseAnalyzer {
  static readonly NAME = "command-injection";
  static readonly VERSION = "1.0.0";

  private readonly observer?: CommandInjectionAnalysisObserver;

  constructor(options: CommandInjectionAnalyzerOptions = {}) {
    super();
    this.observer = options.observer;
  }

  getName(): string {
    return CommandInjectionAnalyzer.NAME;
  }

  getVersion(): string {
    return CommandInjectionAnalyzer.VERSION;
  }

  supportsLanguage(language: Language | string): boolean {
    return (
      language === Language.JAVASCRIPT ||
      language === Language.TYPESCRIPT ||
      language === "js" ||
      language === "ts" ||
      language === "python" ||
      language === "py"
    );
  }

  getSupportedLanguages(): Language[] {
    return [Language.JAVASCRIPT, Language.TYPESCRIPT];
  }

  getRules(): Rule[] {
    return RULES.map((r) => ({ ...r, tags: r.tags ? [...r.tags] : undefined }));
  }

  getRule(ruleId: string): Rule | undefined {
    return this.getRules().find((r) => r.id === ruleId);
  }

  getCapabilities(): AnalyzerCapabilities {
    return {
      ...super.getCapabilities(),
      securityAnalysis: true,
      cwe: ["CWE-78", "CWE-88"],
      fileExtensions: [
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".py",
      ],
    };
  }

  validateConfig(config: AnalyzerConfig): string[] {
    const errors = super.validateConfig(config);
    const severities = new Set<string>(Object.values(Severity));
    for (const [ruleId, rc] of Object.entries(config.rules ?? {})) {
      if (rc === null || (typeof rc !== "boolean" && typeof rc !== "object")) {
        errors.push(`Rule ${ruleId} config must be a boolean or an object`);
      } else if (
        typeof rc === "object" &&
        rc.severity !== undefined &&
        !severities.has(rc.severity)
      ) {
        errors.push(`Rule ${ruleId} has unknown severity: ${String(rc.severity)}`);
      }
    }
    if (
      config.maxFindings !== undefined &&
      (!Number.isInteger(config.maxFindings) || config.maxFindings < 0)
    ) {
      errors.push("maxFindings must be a non-negative integer");
    }
    errors.push(
      ...validateCommandInjectionOptions(
        config.options?.[COMMAND_INJECTION_OPTIONS_KEY],
      ),
    );
    return errors;
  }

  private assertValidConfig(config?: AnalyzerConfig): AnalyzerConfig {
    const cfg = config ?? this.config;
    const errors = this.validateConfig(cfg);
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join(", ")}`);
    }
    return cfg;
  }

  async analyze(
    code: string,
    filePath: string,
    config?: AnalyzerConfig,
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    const cfg = this.assertValidConfig(config);
    if (!this.initialized) await this.initialize(config);
    const opts = resolveCommandInjectionOptions(
      cfg.options?.[COMMAND_INJECTION_OPTIONS_KEY] as CommandInjectionOptions | undefined,
    );

    const skip = (
      reason: CommandInjectionSkipReason,
      message?: string,
    ): AnalysisResult => {
      const file = typeof filePath === "string" ? filePath : "<invalid>";
      notifySafely(() => this.observer?.onFileSkipped?.({ file, reason }));
      return {
        findings: [],
        filesAnalyzed: 0,
        analysisTime: Date.now() - startTime,
        analyzerVersion: CommandInjectionAnalyzer.VERSION,
        summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        errors: message ? [{ file, message }] : undefined,
      };
    };

    if (typeof code !== "string" || typeof filePath !== "string") {
      return skip("invalid-input", "code and filePath must be strings");
    }

    if (isDeclarationFile(filePath)) {
      return skip("declaration-file");
    }

    if (!isSupportedCommandFile(filePath)) {
      return skip("unsupported-file-type");
    }

    const byteLength = Buffer.byteLength(code, "utf8");
    if (byteLength > opts.maxFileBytes) {
      return skip(
        "file-too-large",
        `File size (${byteLength} bytes) exceeds limit (${opts.maxFileBytes} bytes)`,
      );
    }

    if (code.includes("\0")) {
      return skip("binary-content", "Binary content detected (null byte present)");
    }

    const findings = this.scanFile(code, filePath, cfg, opts);
    const durationMs = Date.now() - startTime;

    const findingsByRule: Record<string, number> = {};
    for (const f of findings) {
      findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] ?? 0) + 1;
    }

    notifySafely(() =>
      this.observer?.onFileAnalyzed?.({
        file: filePath,
        durationMs,
        findingsByRule,
      }),
    );

    return {
      findings,
      filesAnalyzed: 1,
      analysisTime: durationMs,
      analyzerVersion: CommandInjectionAnalyzer.VERSION,
      summary: this.computeSummary(findings),
    };
  }

  private scanFile(
    code: string,
    filePath: string,
    config: AnalyzerConfig,
    opts: ResolvedCommandInjectionOptions,
  ): Finding[] {
    const lines = new LineIndex(code);
    const masked = maskComments(code);
    const findings: Finding[] = [];

    const isRuleActive = (ruleId: string): boolean => {
      const entry = config.rules?.[ruleId];
      if (entry === false) return false;
      if (typeof entry === "object" && entry.enabled === false) return false;
      return true;
    };

    const ruleSeverity = (ruleId: string, defaultSev: Severity): Severity => {
      const entry = config.rules?.[ruleId];
      if (typeof entry === "object" && entry.severity) return entry.severity;
      return defaultSev;
    };

    // 1. Scan for Dangerous Shell Option (cmd-002)
    if (isRuleActive(COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION)) {
      const shellMatches = this.findDangerousShellOptions(masked, lines);
      for (const m of shellMatches) {
        findings.push({
          ruleId: COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION,
          message: `Process execution enables '${m.matched}', invoking an OS shell that interprets shell metacharacters and risks command injection (CWE-78).`,
          severity: ruleSeverity(
            COMMAND_INJECTION_RULES.DANGEROUS_SHELL_OPTION,
            Severity.HIGH,
          ),
          location: {
            file: filePath,
            startLine: m.line,
            endLine: m.line,
            startColumn: m.column,
          },
          suggestedFix: {
            description:
              "Set shell: false and pass command arguments as an array to execFile or spawn.",
          },
        });
      }
    }

    // 2. Scan for Incomplete Sanitization (cmd-003)
    if (isRuleActive(COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION)) {
      const incompleteMatches = this.findIncompleteSanitization(masked, lines);
      for (const m of incompleteMatches) {
        findings.push({
          ruleId: COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION,
          message: `Naive command sanitization (${m.matched}): stripping only single characters or spaces fails to protect against command injection metacharacters (;, |, &, $, \`, \\n).`,
          severity: ruleSeverity(
            COMMAND_INJECTION_RULES.INCOMPLETE_SANITIZATION,
            Severity.MEDIUM,
          ),
          location: {
            file: filePath,
            startLine: m.line,
            endLine: m.line,
            startColumn: m.column,
          },
          suggestedFix: {
            description:
              "Use safe argument escaping with an established library (e.g. shlex.quote) or avoid shell invocation.",
          },
        });
      }
    }

    // 3. Scan for Dynamic Command Concatenation (cmd-004) and Unescaped Execution (cmd-001)
    const taintSet = this.collectTaint(masked, opts);
    const sinks = this.findCommandSinks(masked, lines, opts);

    for (const sink of sinks) {
      const hasSanitizer = this.hasSanitizerInProximity(
        masked,
        lines,
        sink.line,
        opts,
      );

      // Check if command argument uses string concatenation or template literal
      const isConcatenated =
        sink.argText.includes("+") ||
        (sink.argText.startsWith("`") && sink.argText.includes("${"));

      if (
        isRuleActive(COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION) &&
        isConcatenated &&
        !hasSanitizer
      ) {
        findings.push({
          ruleId: COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION,
          message: `Command string in '${sink.sinkName}' is built using dynamic string concatenation or template literals: '${sink.argText}'.`,
          severity: ruleSeverity(
            COMMAND_INJECTION_RULES.DYNAMIC_CONCATENATION,
            Severity.HIGH,
          ),
          location: {
            file: filePath,
            startLine: sink.line,
            endLine: sink.line,
            startColumn: sink.column,
          },
          suggestedFix: {
            description:
              "Pass executable and command arguments as separate array elements instead of building a raw command string.",
          },
        });
      }

      // Check if argument is tainted by user input (cmd-001)
      if (isRuleActive(COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION)) {
        const isTainted = this.isArgumentTainted(sink.argText, taintSet);
        if (isTainted && !hasSanitizer) {
          findings.push({
            ruleId: COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION,
            message: `Unsanitized user-controlled input in command execution '${sink.sinkName}': '${sink.argText}' allows arbitrary OS command injection.`,
            severity: ruleSeverity(
              COMMAND_INJECTION_RULES.UNESCAPED_EXECUTION,
              Severity.CRITICAL,
            ),
            location: {
              file: filePath,
              startLine: sink.line,
              endLine: sink.line,
              startColumn: sink.column,
            },
            suggestedFix: {
              description:
                "Validate input against an allowlist, quote with a safe shell escaper, or pass arguments via spawn/execFile array.",
            },
          });
        }
      }
    }

    // Sort findings deterministically
    findings.sort((a, b) => {
      if (a.location.startLine !== b.location.startLine) {
        return a.location.startLine - b.location.startLine;
      }
      if ((a.location.startColumn ?? 0) !== (b.location.startColumn ?? 0)) {
        return (a.location.startColumn ?? 0) - (b.location.startColumn ?? 0);
      }
      return a.ruleId.localeCompare(b.ruleId);
    });

    if (config.maxFindings !== undefined && findings.length > config.maxFindings) {
      return findings.slice(0, config.maxFindings);
    }

    return findings;
  }

  private findDangerousShellOptions(
    code: string,
    lines: LineIndex,
  ): Array<{ matched: string; line: number; column: number }> {
    const results: Array<{ matched: string; line: number; column: number }> = [];
    const patterns = [
      /\bshell\s*:\s*true\b/g,
      /\bshell\s*=\s*True\b/g,
    ];

    for (const pat of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pat.exec(code)) !== null) {
        const pos = lines.position(match.index);
        results.push({
          matched: match[0],
          line: pos.line,
          column: pos.column,
        });
      }
    }
    return results;
  }

  private findIncompleteSanitization(
    code: string,
    lines: LineIndex,
  ): Array<{ matched: string; line: number; column: number }> {
    const results: Array<{ matched: string; line: number; column: number }> = [];
    // Matches e.g. .replace(/;/g, '') or .replace(';', '') or .replace(/&/g, '')
    const patterns = [
      /\.replace\s*\(\s*(?:\/;\/g?|\/&\/g?|\/\\\|\/g?|['"];['"]|['"]&['"]|['"]\|['"])\s*,\s*['"]\s*['"]\s*\)/g,
      /\.replace\s*\(\s*\/\\s\+\/g\s*,\s*['"]\s*['"]\s*\)/g,
    ];

    for (const pat of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pat.exec(code)) !== null) {
        const pos = lines.position(match.index);
        results.push({
          matched: match[0],
          line: pos.line,
          column: pos.column,
        });
      }
    }
    return results;
  }

  private collectTaint(
    code: string,
    opts: ResolvedCommandInjectionOptions,
  ): Set<string> {
    const tainted = new Set<string>();
    const sources = [...BUILTIN_SOURCES];

    for (const src of opts.additionalSources) {
      sources.push({
        kind: "custom",
        re: new RegExp(`\\b${escapeRegExp(src)}\\b`),
      });
    }

    const assignRe =
      /(?:(?:const|let|var)\s+([\w$]+)\s*=\s*([^;\n]+)|([\w$]+)\s*=\s*([^;\n]+))/g;
    let match: RegExpExecArray | null;

    while ((match = assignRe.exec(code)) !== null) {
      const varName = match[1] || match[3];
      const rhs = match[2] || match[4];
      if (!varName || !rhs) continue;

      for (const src of sources) {
        if (src.re.test(rhs)) {
          tainted.add(varName);
          break;
        }
      }

      for (const t of tainted) {
        const idRe = new RegExp(`\\b${escapeRegExp(t)}\\b`);
        if (idRe.test(rhs)) {
          tainted.add(varName);
          break;
        }
      }
    }

    return tainted;
  }

  private findCommandSinks(
    code: string,
    lines: LineIndex,
    opts: ResolvedCommandInjectionOptions,
  ): Array<{ sinkName: string; argText: string; line: number; column: number }> {
    const sinks: Array<{
      sinkName: string;
      argText: string;
      line: number;
      column: number;
    }> = [];

    const sinkDefs = [
      { name: "child_process.exec", re: /(?:child_process\s*\.\s*)?exec\s*\(/g },
      { name: "child_process.execSync", re: /(?:child_process\s*\.\s*)?execSync\s*\(/g },
      { name: "os.system", re: /\bos\s*\.\s*system\s*\(/g },
      { name: "os.popen", re: /\bos\s*\.\s*popen\s*\(/g },
      { name: "subprocess.call", re: /\bsubprocess\s*\.\s*call\s*\(/g },
      { name: "subprocess.Popen", re: /\bsubprocess\s*\.\s*Popen\s*\(/g },
      { name: "subprocess.run", re: /\bsubprocess\s*\.\s*run\s*\(/g },
      { name: "subprocess.check_output", re: /\bsubprocess\s*\.\s*check_output\s*\(/g },
      // Wrapper APIs
      { name: "runCommand", re: /\brunCommand\s*\(/g },
      { name: "execCmd", re: /\bexecCmd\s*\(/g },
      { name: "executeShell", re: /\bexecuteShell\s*\(/g },
    ];

    for (const customSink of opts.additionalSinks) {
      sinkDefs.push({
        name: customSink,
        re: new RegExp(`\\b${escapeRegExp(customSink)}\\s*\\(`, "g"),
      });
    }

    for (const def of sinkDefs) {
      let match: RegExpExecArray | null;
      while ((match = def.re.exec(code)) !== null) {
        const openParen = match.index + match[0].length;
        const callArgs = readCallArgs(code, openParen);
        if (callArgs.args.length > 0) {
          const firstArg = callArgs.args[0].text;
          const pos = lines.position(match.index);
          sinks.push({
            sinkName: def.name,
            argText: firstArg,
            line: pos.line,
            column: pos.column,
          });
        }
      }
    }

    return sinks;
  }

  private hasSanitizerInProximity(
    code: string,
    lines: LineIndex,
    sinkLine: number,
    opts: ResolvedCommandInjectionOptions,
  ): boolean {
    const startLine = Math.max(1, sinkLine - opts.proximityLines);
    const endLine = sinkLine;

    const allLines = code.split("\n");
    const window = allLines.slice(startLine - 1, endLine).join("\n");

    for (const san of opts.safeSanitizers) {
      const sanRe = new RegExp(`\\b${escapeRegExp(san)}\\s*\\(`, "i");
      if (sanRe.test(window)) {
        return true;
      }
    }

    return false;
  }

  private isArgumentTainted(arg: string, taintSet: Set<string>): boolean {
    const trimmed = arg.trim();

    // Constant string literals without interpolation or concatenation
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"') && !trimmed.includes("+")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && !trimmed.includes("+"))
    ) {
      return false;
    }

    for (const src of BUILTIN_SOURCES) {
      if (src.re.test(trimmed)) return true;
    }

    for (const t of taintSet) {
      const tRe = new RegExp(`\\b${escapeRegExp(t)}\\b`);
      if (tRe.test(trimmed)) return true;
    }

    // Common variable/parameter names for commands
    if (
      /\b(?:userInput|userCmd|cmd|command|shellArg|rawInput|param)\b/i.test(
        trimmed,
      )
    ) {
      return true;
    }

    return false;
  }

  private computeSummary(findings: Finding[]) {
    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) {
      if (f.severity in summary) {
        summary[f.severity]++;
      }
    }
    return summary;
  }
}
