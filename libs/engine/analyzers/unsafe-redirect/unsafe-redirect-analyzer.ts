import {
  Analyzer,
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
  isSupportedRedirectFile,
  resolveUnsafeRedirectOptions,
  ResolvedUnsafeRedirectOptions,
  UNSAFE_REDIRECT_OPTIONS_KEY,
  UnsafeRedirectOptions,
  validateUnsafeRedirectOptions,
} from "./config";
import {
  escapeRegExp,
  LineIndex,
  maskComments,
  maskStringContents,
  readCallArgs,
  readExpression,
  skipQuoted,
} from "./lexer";
import {
  notifySafely,
  RedirectAnalysisObserver,
  RedirectSkipReason,
} from "./telemetry";

/**
 * Unsafe redirect validation analyzer.
 *
 * Flags open-redirect patterns (CWE-601) in JavaScript/TypeScript services and
 * front-ends: redirect targets taken from request input without validation,
 * and validation that looks protective but is bypassable (prefix/substring
 * host checks, `startsWith("/")` relative checks, unanchored allowlist regexes).
 *
 * The analysis is deliberately lexical and file-local so it is cheap,
 * dependency-free and deterministic: the same input always yields the same
 * findings in the same order. See docs/UNSAFE_REDIRECT_ANALYSIS.md for the
 * supported patterns and known limitations.
 */

export const UNSAFE_REDIRECT_RULES = {
  UNVALIDATED_REDIRECT: "redirect-001",
  WEAK_HOST_CHECK: "redirect-002",
  RELATIVE_PATH_BYPASS: "redirect-003",
  UNSAFE_REGEX_ALLOWLIST: "redirect-004",
} as const;

export type RedirectSinkKind =
  | "server-redirect"
  | "location-header"
  | "browser-navigation"
  | "custom-sink";

interface SourcePattern {
  kind: string;
  re: RegExp;
}

interface TaintEntry {
  kind: string;
  roots: Set<string>;
}

interface Taint {
  kind: string;
  /** Identifiers the tainted value was derived from (empty for direct sources). */
  roots: Set<string>;
  /** Source expression text when the source appears directly in the value. */
  directSource?: string;
}

const BUILTIN_SOURCES: SourcePattern[] = [
  {
    kind: "referer-header",
    re: /\b(?:req|request|ctx\.request|ctx)\s*\.\s*(?:headers\s*(?:\.\s*refere?r\b|\[\s*['"`]refere?r['"`]\s*\])|get\s*\(\s*['"`]refere?r['"`]|header\s*\(\s*['"`]refere?r['"`])/i,
  },
  {
    kind: "request-input",
    re: /\b(?:req|request|ctx\.request|ctx|event)\s*\.\s*(?:query|body|params|cookies|headers|queryStringParameters)\b/,
  },
  {
    kind: "search-params",
    re: /\b(?:[\w$]*[sS]earchParams|query|params)\s*\.\s*(?:get|getAll)\s*\(/,
  },
  { kind: "router-query", re: /\brouter\s*\.\s*query\b/ },
  {
    kind: "browser-location",
    re: /\b(?:location\s*\.\s*(?:search|hash)|document\s*\.\s*(?:referrer|URL)|window\s*\.\s*name)\b/,
  },
];

const SOURCE_LABELS: Record<string, string> = {
  "referer-header": "the Referer header",
  "request-input": "request input",
  "search-params": "URL search parameters",
  "router-query": "router query parameters",
  "browser-location": "the browser location",
  custom: "a configured request source",
};

const URLISH_NAME =
  /(?:url|uri|redirect|next|return|target|dest|goto|continue|callback|host|origin|referr?er|location|href)/i;

const JS_KEYWORDS = new Set(
  (
    "await break case catch class const continue debugger default delete do else export extends " +
    "false finally for function if import in instanceof let new null of return super switch this " +
    "throw true try typeof undefined var void while with yield async as"
  ).split(" "),
);

const RULES: Rule[] = [
  {
    id: UNSAFE_REDIRECT_RULES.UNVALIDATED_REDIRECT,
    name: "Unvalidated Redirect Target",
    description:
      "A redirect or navigation target is derived from request-controlled input without allowlist validation (open redirect, CWE-601).",
    severity: Severity.HIGH,
    category: "security",
    enabled: true,
    tags: ["open-redirect", "cwe-601", "input-validation"],
    documentationUrl: "https://docs.gasguard.dev/rules/redirect-001",
  },
  {
    id: UNSAFE_REDIRECT_RULES.WEAK_HOST_CHECK,
    name: "Bypassable Redirect Host Check",
    description:
      "Redirect host validation uses prefix, suffix or substring matching that an attacker-controlled host can satisfy.",
    severity: Severity.MEDIUM,
    category: "security",
    enabled: true,
    tags: ["open-redirect", "cwe-601", "validation-bypass"],
    documentationUrl: "https://docs.gasguard.dev/rules/redirect-002",
  },
  {
    id: UNSAFE_REDIRECT_RULES.RELATIVE_PATH_BYPASS,
    name: "Relative Redirect Check Allows Protocol-Relative URLs",
    description:
      "A check that a redirect target starts with '/' also accepts '//evil.example' and '/\\evil.example', which browsers treat as absolute.",
    severity: Severity.MEDIUM,
    category: "security",
    enabled: true,
    tags: ["open-redirect", "cwe-601", "validation-bypass"],
    documentationUrl: "https://docs.gasguard.dev/rules/redirect-003",
  },
  {
    id: UNSAFE_REDIRECT_RULES.UNSAFE_REGEX_ALLOWLIST,
    name: "Bypassable Redirect Allowlist Regex",
    description:
      "A redirect allowlist regular expression is unanchored or leaves the host's dots unescaped, so other hosts match it.",
    severity: Severity.MEDIUM,
    category: "security",
    enabled: true,
    tags: ["open-redirect", "cwe-601", "regex", "validation-bypass"],
    documentationUrl: "https://docs.gasguard.dev/rules/redirect-004",
  },
];

const FIXES: Record<string, string> = {
  [UNSAFE_REDIRECT_RULES.UNVALIDATED_REDIRECT]:
    "Parse the target with new URL(target, ownOrigin) and redirect only if its origin is in an explicit allowlist; otherwise fall back to a fixed path.",
  [UNSAFE_REDIRECT_RULES.WEAK_HOST_CHECK]:
    "Parse the URL and compare url.hostname for exact equality (or endsWith('.' + allowedHost) for subdomains) against an allowlist.",
  [UNSAFE_REDIRECT_RULES.RELATIVE_PATH_BYPASS]:
    "Also reject targets starting with '//' or '/\\', or resolve with new URL(target, ownOrigin) and require the origin to equal ownOrigin.",
  [UNSAFE_REDIRECT_RULES.UNSAFE_REGEX_ALLOWLIST]:
    "Anchor the pattern (^...$ or a trailing (?:/|$)), escape every '.' in the host, and avoid wildcards before the host.",
};

export interface UnsafeRedirectAnalyzerOptions {
  observer?: RedirectAnalysisObserver;
}

export class UnsafeRedirectAnalyzer extends BaseAnalyzer implements Analyzer {
  static readonly NAME = "UnsafeRedirectAnalyzer";
  static readonly VERSION = "1.0.0";

  private readonly observer?: RedirectAnalysisObserver;

  constructor(options: UnsafeRedirectAnalyzerOptions = {}) {
    super();
    this.observer = options.observer;
  }

  getName(): string {
    return UnsafeRedirectAnalyzer.NAME;
  }

  getVersion(): string {
    return UnsafeRedirectAnalyzer.VERSION;
  }

  supportsLanguage(language: Language | string): boolean {
    return (
      language === Language.JAVASCRIPT ||
      language === Language.TYPESCRIPT ||
      language === "js" ||
      language === "ts"
    );
  }

  getSupportedLanguages(): Language[] {
    return [Language.JAVASCRIPT, Language.TYPESCRIPT];
  }

  getRules(): Rule[] {
    return RULES.map((r) => ({ ...r, tags: r.tags ? [...r.tags] : undefined }));
  }

  getCapabilities(): AnalyzerCapabilities {
    return {
      ...super.getCapabilities(),
      securityAnalysis: true,
      cwe: ["CWE-601"],
      fileExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
    };
  }

  validateConfig(config: AnalyzerConfig): string[] {
    const errors = super.validateConfig(config);
    const severities = new Set<string>(Object.values(Severity));
    for (const [ruleId, rc] of Object.entries(config.rules ?? {})) {
      if (rc === null || (typeof rc !== "boolean" && typeof rc !== "object")) {
        errors.push(`Rule ${ruleId} config must be a boolean or an object`);
      } else if (typeof rc === "object" && rc.severity !== undefined && !severities.has(rc.severity)) {
        errors.push(`Rule ${ruleId} has unknown severity: ${String(rc.severity)}`);
      }
    }
    if (
      config.maxFindings !== undefined &&
      (!Number.isInteger(config.maxFindings) || config.maxFindings < 0)
    ) {
      errors.push("maxFindings must be a non-negative integer");
    }
    errors.push(...validateUnsafeRedirectOptions(config.options?.[UNSAFE_REDIRECT_OPTIONS_KEY]));
    return errors;
  }

  async analyze(code: string, filePath: string, config?: AnalyzerConfig): Promise<AnalysisResult> {
    const startTime = Date.now();
    const cfg = this.assertValidConfig(config);
    if (!this.initialized) await this.initialize(config);
    const opts = resolveUnsafeRedirectOptions(
      cfg.options?.[UNSAFE_REDIRECT_OPTIONS_KEY] as UnsafeRedirectOptions | undefined,
    );

    const skip = (reason: RedirectSkipReason, message?: string): AnalysisResult => {
      const file = typeof filePath === "string" ? filePath : "<invalid>";
      notifySafely(() => this.observer?.onFileSkipped?.({ file, reason }));
      return {
        ...this.buildResult([], 0, startTime),
        errors: message ? [{ file, message }] : undefined,
      };
    };

    if (typeof filePath !== "string" || filePath.trim() === "") {
      return skip("invalid-input", "file path must be a non-empty string");
    }
    if (typeof code !== "string") {
      return skip("invalid-input", "file content must be a string");
    }
    if (isDeclarationFile(filePath)) return skip("declaration-file");
    if (!isSupportedRedirectFile(filePath)) {
      return skip(
        "unsupported-file-type",
        `unsupported file type "${fileExtension(filePath) || "(none)"}"; skipped by ${this.getName()}`,
      );
    }
    if (!this.shouldAnalyzeFile(filePath, cfg)) return skip("excluded-by-config");

    const bytes = byteLength(code);
    if (bytes > opts.maxFileBytes) {
      return skip(
        "file-too-large",
        `file is ${bytes} bytes, above maxFileBytes (${opts.maxFileBytes}); skipped`,
      );
    }
    if (code.includes("\u0000")) {
      return skip("binary-content", "file appears to be binary; skipped");
    }

    const fileStart = Date.now();
    let findings = this.scan(code, filePath, opts, cfg);
    findings = this.applyMaxFindings(sortFindings(findings), cfg);

    const findingsByRule: Record<string, number> = {};
    for (const f of findings) findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] ?? 0) + 1;
    notifySafely(() =>
      this.observer?.onFileAnalyzed?.({
        file: filePath,
        durationMs: Date.now() - fileStart,
        findingsByRule,
      }),
    );

    return this.buildResult(findings, 1, startTime);
  }

  async analyzeMultiple(files: Map<string, string>, config?: AnalyzerConfig): Promise<AnalysisResult> {
    const cfg = this.assertValidConfig(config);
    if (!(files instanceof Map)) {
      throw new TypeError("files must be a Map of file path to content");
    }

    // Unsupported files are expected in polyglot repositories, so they are
    // skipped here silently (counted via telemetry) instead of producing one
    // error entry per Solidity/Rust/etc. file.
    const supported = new Map<string, string>();
    for (const [path, content] of files) {
      if (typeof path === "string" && isSupportedRedirectFile(path)) {
        supported.set(path, content);
      } else {
        const reason: RedirectSkipReason =
          typeof path === "string" && isDeclarationFile(path)
            ? "declaration-file"
            : "unsupported-file-type";
        notifySafely(() =>
          this.observer?.onFileSkipped?.({ file: String(path), reason }),
        );
      }
    }

    const result = await super.analyzeMultiple(supported, cfg);
    const findings = this.applyMaxFindings(sortFindings(result.findings), cfg);
    return {
      ...result,
      findings,
      summary: this.calculateSummary(findings),
      totalEstimatedGasSavings: undefined,
      errors: result.errors?.map(({ file, message }) => ({ file, message })),
    };
  }

  private assertValidConfig(config?: AnalyzerConfig): AnalyzerConfig {
    const cfg = config ?? this.config;
    const errors = this.validateConfig(cfg);
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join(", ")}`);
    }
    return cfg;
  }

  private applyMaxFindings(findings: Finding[], cfg: AnalyzerConfig): Finding[] {
    return cfg.maxFindings !== undefined ? findings.slice(0, cfg.maxFindings) : findings;
  }

  private buildResult(findings: Finding[], filesAnalyzed: number, startTime: number): AnalysisResult {
    return {
      findings,
      filesAnalyzed,
      analysisTime: Date.now() - startTime,
      analyzerVersion: this.getVersion(),
      summary: this.calculateSummary(findings),
    };
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  private scan(
    code: string,
    filePath: string,
    opts: ResolvedUnsafeRedirectOptions,
    cfg: AnalyzerConfig,
  ): Finding[] {
    const ctx = new ScanContext(code, opts);
    const findings: Finding[] = [];

    const emit = (
      ruleId: string,
      offset: number,
      message: string,
      metadata: Record<string, unknown>,
    ) => {
      const rule = this.resolveRule(ruleId, cfg);
      if (!rule) return;
      const { line, column } = ctx.lines.position(offset);
      findings.push({
        ruleId,
        message,
        severity: rule.severity,
        location: { file: filePath, startLine: line, endLine: line, startColumn: column },
        suggestedFix: { description: FIXES[ruleId], documentationUrl: rule.documentationUrl },
        metadata: { analyzer: this.getName(), category: "security", cwe: "CWE-601", ...metadata },
      });
    };

    ctx.collectUnvalidatedRedirects(emit);
    ctx.collectWeakChecks(emit);
    ctx.collectRegexAllowlists(emit);

    return dedupeFindings(findings);
  }

  private resolveRule(ruleId: string, cfg: AnalyzerConfig): { severity: Severity; documentationUrl?: string } | undefined {
    const base = RULES.find((r) => r.id === ruleId);
    if (!base) return undefined;
    const override = cfg.rules?.[ruleId];
    if (override === false) return undefined;
    if (override && typeof override === "object") {
      if (override.enabled === false) return undefined;
      return { severity: override.severity ?? base.severity, documentationUrl: base.documentationUrl };
    }
    return base.enabled ? { severity: base.severity, documentationUrl: base.documentationUrl } : undefined;
  }
}

type Emit = (
  ruleId: string,
  offset: number,
  message: string,
  metadata: Record<string, unknown>,
) => void;

/** Per-file detection state. Never shared between files or analyzer runs. */
class ScanContext {
  readonly masked: string;
  readonly maskedLines: string[];
  readonly lines: LineIndex;
  private readonly sources: SourcePattern[];
  private readonly validatorAlt: string;
  private readonly validatorWrapped: RegExp;
  /** Identifiers tainted at any point; used to judge validation relevance. */
  private readonly everTainted = new Set<string>();
  private readonly taintRoots = new Map<string, Set<string>>();

  constructor(code: string, private readonly opts: ResolvedUnsafeRedirectOptions) {
    this.masked = maskComments(code);
    this.maskedLines = this.masked.split("\n");
    this.lines = new LineIndex(this.masked);
    this.sources = [
      ...BUILTIN_SOURCES,
      ...opts.additionalSources.map((path) => ({
        kind: "custom",
        re: new RegExp(`(?<![\\w$.])${dottedPattern(path)}\\b`),
      })),
    ];
    this.validatorAlt = opts.safeValidators.map(escapeRegExp).join("|");
    this.validatorWrapped = new RegExp(
      `^(?:await\\s+)?(?:[\\w$]+\\s*\\.\\s*)*(?:${this.validatorAlt})\\s*\\(`,
    );
  }

  // --- redirect-001 --------------------------------------------------------

  collectUnvalidatedRedirects(emit: Emit): void {
    type Event =
      | { offset: number; type: "assign"; names: string[]; rhs: string }
      | { offset: number; type: "sink"; kind: RedirectSinkKind; target: string; backLiteral?: boolean };

    const events: Event[] = [];
    for (const a of this.findAssignments()) events.push({ type: "assign", ...a });
    for (const s of this.findSinks()) events.push({ type: "sink", ...s });
    events.sort((a, b) => a.offset - b.offset || (a.type === "assign" ? -1 : 1));

    const tainted = new Map<string, TaintEntry>();

    for (const ev of events) {
      if (ev.type === "assign") {
        const t = this.evaluate(ev.rhs, tainted);
        for (const name of ev.names) {
          if (t) {
            const roots = new Set<string>(t.roots);
            tainted.set(name, { kind: t.kind, roots });
            this.everTainted.add(name);
            this.taintRoots.set(name, roots);
          } else {
            tainted.delete(name);
          }
        }
        continue;
      }

      const sinkLine = this.lines.position(ev.offset).line;
      if (ev.backLiteral) {
        emit(
          UNSAFE_REDIRECT_RULES.UNVALIDATED_REDIRECT,
          ev.offset,
          `Redirect to "back" sends the user to the Referer header, which is attacker-controlled.`,
          { sinkKind: ev.kind, sourceKind: "referer-header" },
        );
        continue;
      }

      const t = this.evaluate(ev.target, tainted);
      if (!t) continue;
      if (this.hasGuard(t, sinkLine)) continue;

      emit(
        UNSAFE_REDIRECT_RULES.UNVALIDATED_REDIRECT,
        ev.offset,
        `Redirect target flows from ${SOURCE_LABELS[t.kind] ?? "request input"} into a ${ev.kind} without allowlist validation.`,
        { sinkKind: ev.kind, sourceKind: t.kind },
      );
    }
  }

  private findAssignments(): Array<{ offset: number; names: string[]; rhs: string }> {
    const out: Array<{ offset: number; names: string[]; rhs: string }> = [];
    const text = this.masked;

    const simple =
      /(?<![\w$.]|\.\s+)([A-Za-z_$][\w$]*)\s*(?::\s*[\w$<>\[\]|. ]+?)?\s*=(?![=>])/g;
    for (const m of text.matchAll(simple)) {
      const name = m[1];
      if (JS_KEYWORDS.has(name) || this.inString(m.index!)) continue;
      const rhsStart = m.index! + m[0].length;
      out.push({ offset: m.index!, names: [name], rhs: readExpression(text, rhsStart) });
    }

    const destructure = /\b(?:const|let|var)\s*([{[])/g;
    for (const m of text.matchAll(destructure)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close < 0) continue;
      const after = /^\s*(?::[^=\n]+)?=(?![=>])\s*/.exec(text.slice(close + 1));
      if (!after) continue;
      const names = destructuredNames(text.slice(open + 1, close));
      if (names.length === 0) continue;
      out.push({
        offset: m.index!,
        names,
        rhs: readExpression(text, close + 1 + after[0].length),
      });
    }
    return out;
  }

  private findSinks(): Array<{ offset: number; kind: RedirectSinkKind; target: string; backLiteral?: boolean }> {
    const text = this.masked;
    const out: Array<{ offset: number; kind: RedirectSinkKind; target: string; backLiteral?: boolean }> = [];

    const callSinks: Array<{ kind: RedirectSinkKind; re: RegExp; mode: "redirect" | "first" | "rest" }> = [
      {
        kind: "server-redirect",
        re: /\b(?:res|response|reply|ctx|h|NextResponse|Response)\s*\.\s*redirect\s*\(/g,
        mode: "redirect",
      },
      { kind: "server-redirect", re: /(?<![\w$]|\.\s*|function\s+)redirect\s*\(/g, mode: "first" },
      {
        kind: "location-header",
        re: /\b(?:res|response|ctx|reply|headers)\s*\.\s*(?:setHeader|set|header|append)\s*\(\s*['"`][Ll]ocation['"`]\s*,/g,
        mode: "rest",
      },
      { kind: "browser-navigation", re: /\blocation\s*\.\s*(?:assign|replace)\s*\(/g, mode: "first" },
      { kind: "browser-navigation", re: /\bwindow\s*\.\s*open\s*\(/g, mode: "first" },
      ...this.opts.additionalSinks.map((name) => ({
        kind: "custom-sink" as RedirectSinkKind,
        re: new RegExp(`(?<![\\w$.])${dottedPattern(name)}\\s*\\(`, "g"),
        mode: "first" as const,
      })),
    ];

    for (const sink of callSinks) {
      for (const m of text.matchAll(sink.re)) {
        if (this.inString(m.index!)) continue;
        const { args, end } = readCallArgs(text, m.index! + m[0].length);
        // `redirect(url) {` / `redirect(url: string)` is a declaration, not a call.
        if (sink.mode === "first" && /^\)\s*[:{]/.test(text.slice(end, end + 40))) continue;
        if (args.length === 0) continue;
        let target: string;
        if (sink.mode === "redirect" && args.length >= 2 && /^\d+$/.test(args[0].text)) {
          target = args[args.length - 1].text;
        } else if (sink.mode === "rest") {
          target = args.map((a) => a.text).join(", ");
        } else {
          target = args[0].text;
        }
        const backLiteral =
          sink.kind === "server-redirect" && /^(['"`])back\1$/.test(target);
        out.push({ offset: m.index!, kind: sink.kind, target, backLiteral });
      }
    }

    const assignSink =
      /(?<![\w$.]|(?:const|let|var)\s+)(?:(?:window|document|self|top|globalThis)\s*\.\s*)?location(?:\s*\.\s*href)?\s*=(?![=>])/g;
    for (const m of text.matchAll(assignSink)) {
      if (this.inString(m.index!)) continue;
      out.push({
        offset: m.index!,
        kind: "browser-navigation",
        target: readExpression(text, m.index! + m[0].length),
      });
    }

    const writeHead = /\bwriteHead\s*\(\s*30[1-8]\b\s*,/g;
    for (const m of text.matchAll(writeHead)) {
      if (this.inString(m.index!)) continue;
      const { args } = readCallArgs(text, m.index! + m[0].length);
      for (const arg of args) {
        const loc = /['"]?[Ll]ocation['"]?\s*:\s*/.exec(arg.text);
        if (!loc) continue;
        out.push({
          offset: m.index!,
          kind: "location-header",
          target: readExpression(arg.text, loc.index + loc[0].length),
        });
      }
    }

    return out;
  }

  /** Determine whether `expr` carries request-controlled data. */
  private evaluate(expr: string, tainted: Map<string, TaintEntry>): Taint | null {
    const trimmed = expr.trim();
    if (!trimmed || hasFixedOrigin(trimmed) || this.validatorWrapped.test(trimmed)) {
      return null;
    }

    const stringless = maskStringContents(trimmed);
    for (const source of this.sources) {
      const m = source.re.exec(trimmed);
      if (m && stringless[m.index] === trimmed[m.index]) {
        return { kind: source.kind, roots: new Set(), directSource: sourceChain(trimmed, m.index) };
      }
    }

    for (const id of identifiersIn(stringless)) {
      const entry = tainted.get(id);
      if (entry) return { kind: entry.kind, roots: new Set([id, ...entry.roots]) };
    }
    return null;
  }

  /** A validator, allowlist lookup, exact host comparison or (weak) check near the sink. */
  private hasGuard(t: Taint, sinkLine: number): boolean {
    const from = Math.max(0, sinkLine - 1 - this.opts.proximityLines);
    const window = this.maskedLines.slice(from, sinkLine);

    if (t.directSource) {
      const needle = t.directSource.replace(/\s+/g, "");
      const marker = new RegExp(
        `\\b(?:${this.validatorAlt})\\s*\\(|\\.\\s*(?:includes|has|indexOf|some|find|startsWith|endsWith|match|test)\\s*\\(|\\b(?:host|hostname|origin)\\b\\s*[!=]==?`,
      );
      // The sink line itself contains the source; only a validator there counts.
      return window.some((line, idx) => {
        const compact = line.replace(/\s+/g, "");
        if (!compact.includes(needle)) return false;
        if (from + idx === sinkLine - 1) {
          return new RegExp(`\\b(?:${this.validatorAlt})\\s*\\(`).test(line);
        }
        return marker.test(line);
      });
    }

    const names = new Set<string>(t.roots);
    for (const [name, roots] of this.taintRoots) {
      for (const r of t.roots) if (roots.has(r)) names.add(name);
    }

    for (const name of names) {
      const ref = `(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`;
      const guards = [
        new RegExp(`\\b(?:${this.validatorAlt})\\s*\\([^;\\n]*${ref}`),
        new RegExp(`\\.\\s*(?:includes|has|indexOf|some|find|findIndex)\\s*\\([^;\\n]*${ref}`),
        new RegExp(
          `${ref}(?:\\s*\\??\\.\\s*[\\w$]+)*\\s*(?:\\??\\.\\s*(?:startsWith|endsWith|includes|indexOf|match)\\s*\\(|\\[\\s*0\\s*\\]|\\.\\s*charAt\\s*\\(\\s*0\\s*\\))`,
        ),
        new RegExp(`\\.\\s*test\\s*\\([^;\\n]*${ref}`),
      ];
      const hostCompare = /\b(?:host|hostname|origin)\b\s*[!=]==?|[!=]==?\s*[\w$.]*\b(?:host|hostname|origin)\b/;
      const refRe = new RegExp(ref);
      for (const line of window) {
        if (guards.some((g) => g.test(line))) return true;
        if (refRe.test(line) && hostCompare.test(line)) return true;
      }
    }
    return false;
  }

  // --- redirect-002 / redirect-003 -------------------------------------------

  collectWeakChecks(emit: Emit): void {
    const text = this.masked;
    const receiver =
      String.raw`((?:new\s+URL\s*\([^()\n]*(?:\([^()\n]*\))?[^()\n]*\)|[A-Za-z_$][\w$]*)(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])*)`;
    const methodCall = new RegExp(
      String.raw`(?<![\w$.])${receiver}\s*\??\.\s*(startsWith|endsWith|includes|indexOf)\s*\(\s*(['"\x60])([^'"\x60\n]*)\3\s*(?=[,)])`,
      "g",
    );

    for (const m of text.matchAll(methodCall)) {
      if (this.inString(m.index!)) continue;
      const [, recv, method, , literal] = m;
      if (!this.isRedirectRelevant(recv)) continue;
      const offset = m.index!;

      if (method === "startsWith" && literal === "/") {
        if (!this.hasProtocolRelativeGuard(offset)) {
          emit(
            UNSAFE_REDIRECT_RULES.RELATIVE_PATH_BYPASS,
            offset,
            `Relative-path check with startsWith("/") also accepts protocol-relative targets such as "//evil.example".`,
            { method },
          );
        }
        continue;
      }

      const reason = weakLiteralReason(method, literal);
      if (reason) {
        emit(
          UNSAFE_REDIRECT_RULES.WEAK_HOST_CHECK,
          offset,
          `Redirect host validation with ${method}() can be bypassed (${reason}).`,
          { method, reason },
        );
      }
    }

    const firstChar =
      /(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\[\s*0\s*\]|\.\s*charAt\s*\(\s*0\s*\))\s*===?\s*(['"`])\/\2/g;
    for (const m of text.matchAll(firstChar)) {
      if (this.inString(m.index!) || !this.isRedirectRelevant(m[1])) continue;
      if (this.hasProtocolRelativeGuard(m.index!)) continue;
      emit(
        UNSAFE_REDIRECT_RULES.RELATIVE_PATH_BYPASS,
        m.index!,
        `Relative-path check on the first character also accepts protocol-relative targets such as "//evil.example".`,
        { method: "first-character" },
      );
    }
  }

  private hasProtocolRelativeGuard(offset: number): boolean {
    const line = this.lines.position(offset).line;
    const from = Math.max(0, line - 1 - this.opts.proximityLines);
    const to = Math.min(this.maskedLines.length, line + this.opts.proximityLines);
    const guard =
      /startsWith\s*\(\s*['"`](?:\/\/|\/\\\\)|charAt\s*\(\s*1\s*\)|\[\s*1\s*\]|\^\\\/\(\?!|\^\/\(\?!|\^\\\/\[\^|\^\/\[\^|\bisRelativeUrl\b/;
    return this.maskedLines.slice(from, to).some((l) => guard.test(l));
  }

  // --- redirect-004 ----------------------------------------------------------

  collectRegexAllowlists(emit: Emit): void {
    const text = this.masked;
    const body = String.raw`((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n\[])+)`;

    const report = (offset: number, pattern: string) => {
      const reasons = analyzeHostRegex(pattern);
      if (reasons.length === 0) return;
      emit(
        UNSAFE_REDIRECT_RULES.UNSAFE_REGEX_ALLOWLIST,
        offset,
        `Redirect allowlist regex can match untrusted hosts (${reasons.join(", ")}).`,
        { reasons },
      );
    };

    const literalTest = new RegExp(String.raw`(?<![\w$)\]])/${body}/([dgimsuy]*)\s*\.\s*test\s*\(`, "g");
    for (const m of text.matchAll(literalTest)) {
      if (this.inString(m.index!)) continue;
      const { args } = readCallArgs(text, m.index! + m[0].length);
      const arg = args[0]?.text ?? "";
      if (hasScheme(m[1]) || (isHostLike(m[1]) && this.isRedirectRelevant(arg))) {
        report(m.index!, m[1]);
      }
    }

    const literalMatch = new RegExp(
      String.raw`(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*match\s*\(\s*/${body}/([dgimsuy]*)\s*\)`,
      "g",
    );
    for (const m of text.matchAll(literalMatch)) {
      if (this.inString(m.index!)) continue;
      if (hasScheme(m[2]) || (isHostLike(m[2]) && this.isRedirectRelevant(m[1]))) {
        report(m.index!, m[2]);
      }
    }

    const ctor = /new\s+RegExp\s*\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    for (const m of text.matchAll(ctor)) {
      if (this.inString(m.index!)) continue;
      const pattern = m[2].replace(/\\(.)/g, (_s, c: string) => (c === "\\" ? "\\" : c));
      if (hasScheme(pattern)) report(m.index!, pattern);
    }
  }

  // --- helpers ---------------------------------------------------------------

  private isRedirectRelevant(expr: string): boolean {
    if (!expr) return false;
    for (const source of this.sources) if (source.re.test(expr)) return true;
    const ids = identifiersIn(maskStringContents(expr));
    if (ids.some((id) => this.everTainted.has(id))) return true;
    return URLISH_NAME.test(maskStringContents(expr));
  }

  /** True when `offset` sits inside a string literal on its line. */
  private inString(offset: number): boolean {
    const { line } = this.lines.position(offset);
    const lineStart = offset - (this.lines.position(offset).column - 1);
    const lineText = this.maskedLines[line - 1] ?? "";
    const rel = offset - lineStart;
    let i = 0;
    while (i < rel && i < lineText.length) {
      const ch = lineText[i];
      if (ch === "'" || ch === '"') {
        const end = skipQuoted(lineText, i);
        if (rel < end) return true;
        i = end;
        continue;
      }
      i++;
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

function dottedPattern(path: string): string {
  return path.split(".").map(escapeRegExp).join("\\s*\\.\\s*");
}

function identifiersIn(expr: string): string[] {
  const ids: string[] = [];
  for (const m of expr.matchAll(/(?<![\w$.]|\.\s+)([A-Za-z_$][\w$]*)/g)) {
    if (!JS_KEYWORDS.has(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** Full member chain starting at a source match, e.g. `req.query.next`. */
function sourceChain(expr: string, index: number): string {
  const m = /^[\w$.\s]*(?:\[[^\]\n]*\][\w$.]*)*(?:\([^()\n]*\))?/.exec(expr.slice(index));
  return (m ? m[0] : expr.slice(index)).trim();
}

/**
 * A value whose origin (scheme + host) is fixed by a leading literal, e.g.
 * `"/login?next=" + x` or `` `https://app.example/${x}` ``, cannot redirect
 * off-site regardless of what follows.
 */
function hasFixedOrigin(expr: string): boolean {
  const quote = expr[0];
  if (quote !== "'" && quote !== '"' && quote !== "`") return false;

  let prefix = "";
  let i = 1;
  let closed = false;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "\\") {
      prefix += expr[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) {
      closed = true;
      break;
    }
    if (quote === "`" && ch === "$" && expr[i + 1] === "{") break;
    prefix += ch;
    i++;
  }

  // A complete literal on its own is constant and therefore safe.
  if (closed && expr.slice(i + 1).trim() === "") return true;
  return /^\/[^/\\]/.test(prefix) || /^https?:\/\/[^/?#\\@]+[/?#]/i.test(prefix);
}

function weakLiteralReason(method: string, literal: string): string | undefined {
  const hostLike = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(literal);
  switch (method) {
    case "startsWith":
      if (/^(?:https?:)?\/\/[^/?#]+$/i.test(literal)) {
        return "prefix match without a path boundary accepts hosts like 'trusted.example.evil.net'";
      }
      if (/^https?:?(?:\/\/)?$/i.test(literal)) {
        return "scheme-only check accepts any host";
      }
      return undefined;
    case "endsWith":
      if (hostLike && !literal.startsWith(".")) {
        return "suffix match without a leading dot accepts hosts like 'eviltrusted.example'";
      }
      return undefined;
    case "includes":
    case "indexOf":
      if (hostLike || /:\/\//.test(literal)) {
        return "substring match accepts the trusted host anywhere in the URL";
      }
      return undefined;
    default:
      return undefined;
  }
}

function hasScheme(pattern: string): boolean {
  return /https\??|:\\?\/\\?\//i.test(pattern);
}

const HOST_IN_REGEX = /[a-z0-9-]+(?:(?:\\\.|\.)[a-z0-9-]+)+/gi;

function isHostLike(pattern: string): boolean {
  return /[a-z0-9-]+(?:\\\.|\.)[a-z]{2,}/i.test(pattern);
}

/** Reasons a host-allowlist regex accepts hosts it was not meant to. */
export function analyzeHostRegex(pattern: string): string[] {
  const hosts = [...pattern.matchAll(HOST_IN_REGEX)].filter((m) => /[a-z]{2,}$/i.test(m[0]));
  if (hosts.length === 0) return [];

  const reasons: string[] = [];
  const host = hosts[0];
  const hostStart = host.index!;
  const hostEnd = hostStart + host[0].length;

  if (!pattern.startsWith("^")) {
    reasons.push("missing start anchor");
  } else if (/(?<!\\)\.[*+]/.test(pattern.slice(0, hostStart))) {
    reasons.push("wildcard before host");
  }

  if (hosts.some((h) => /(?<!\\)\./.test(h[0]))) {
    reasons.push("unescaped '.' in host");
  }

  const after = pattern.slice(hostEnd).replace(/^\((?:\?[:=])?/, "");
  if (!/^(?:\$|\\?\/|\\?:|\[\\?\/|\\b)/.test(after)) {
    reasons.push("host not terminated by '$', '/' or ':'");
  }

  return reasons;
}

function destructuredNames(pattern: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of pattern) {
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);

  for (const raw of parts) {
    let part = raw.split("=")[0].trim().replace(/^\.\.\./, "");
    if (part.includes(":")) part = part.slice(part.indexOf(":") + 1).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(part) && !JS_KEYWORDS.has(part)) names.push(part);
  }
  return names;
}

function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(text, i) - 1;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function byteLength(code: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(code, "utf8");
  return new TextEncoder().encode(code).length;
}

const SEVERITY_ORDER: Record<string, number> = {
  [Severity.CRITICAL]: 0,
  [Severity.HIGH]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.LOW]: 3,
  [Severity.INFO]: 4,
};

/** Stable order: file, line, column, rule id, severity. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      cmp(a.location.file, b.location.file) ||
      a.location.startLine - b.location.startLine ||
      (a.location.startColumn ?? 0) - (b.location.startColumn ?? 0) ||
      cmp(a.ruleId, b.ruleId) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.ruleId}:${f.location.startLine}:${f.location.startColumn ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
