import { Severity } from "../../core/analyzer-interface";
import {
  analyzeHostRegex,
  RedirectAnalysisMetrics,
  UNSAFE_REDIRECT_RULES as R,
  UnsafeRedirectAnalyzer,
} from "./index";

async function scan(code: string, file = "src/app.ts", config?: any) {
  return new UnsafeRedirectAnalyzer().analyze(code, file, config);
}

function ids(findings: Array<{ ruleId: string; location: { startLine: number } }>) {
  return findings.map((f) => `${f.ruleId}@${f.location.startLine}`);
}

describe("UnsafeRedirectAnalyzer", () => {
  describe("metadata", () => {
    it("exposes four security rules and JS/TS support", () => {
      const a = new UnsafeRedirectAnalyzer();
      expect(a.getName()).toBe("UnsafeRedirectAnalyzer");
      expect(a.getRules().map((r) => r.id)).toEqual([
        R.UNVALIDATED_REDIRECT,
        R.WEAK_HOST_CHECK,
        R.RELATIVE_PATH_BYPASS,
        R.UNSAFE_REGEX_ALLOWLIST,
      ]);
      expect(a.getRules().every((r) => r.category === "security")).toBe(true);
      expect(a.supportsLanguage("typescript")).toBe(true);
      expect(a.supportsLanguage("solidity")).toBe(false);
      expect(a.getCapabilities()).toEqual(
        expect.objectContaining({ securityAnalysis: true, cwe: ["CWE-601"] }),
      );
    });

    it("returns copies of rules so callers cannot mutate analyzer state", () => {
      const a = new UnsafeRedirectAnalyzer();
      a.getRules()[0].severity = Severity.INFO;
      expect(a.getRule(R.UNVALIDATED_REDIRECT)!.severity).toBe(Severity.HIGH);
    });
  });

  describe("redirect-001 unvalidated redirect", () => {
    it.each([
      ["express direct", `res.redirect(req.query.next);`, "request-input"],
      ["express status form", `res.redirect(302, req.body.url);`, "request-input"],
      ["koa", `ctx.redirect(ctx.query.url);`, "request-input"],
      ["fastify", `reply.redirect(request.params.to);`, "request-input"],
      ["referer header", `res.redirect(req.headers.referer);`, "referer-header"],
      ["referer via get()", `res.redirect(req.get('Referer'));`, "referer-header"],
      ["location header", `res.setHeader('Location', req.query.next);`, "request-input"],
      ["writeHead", `res.writeHead(302, { Location: req.query.next });`, "request-input"],
      ["browser assign", `window.location.href = new URLSearchParams(location.search).get('r');`, "browser-location"],
      ["location.replace", `location.replace(searchParams.get('next'));`, "search-params"],
      ["window.open", `window.open(router.query.url);`, "router-query"],
      ["framework redirect()", `return redirect(params.get('to'));`, "search-params"],
    ])("flags %s", async (_name, line, sourceKind) => {
      const r = await scan(line);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].ruleId).toBe(R.UNVALIDATED_REDIRECT);
      expect(r.findings[0].metadata).toEqual(expect.objectContaining({ sourceKind, cwe: "CWE-601" }));
    });

    it("tracks taint through variables, destructuring and template literals", async () => {
      const r = await scan(
        [
          "const { next, other: alias } = req.query;",
          "const target = `${next}`;",
          "res.redirect(target);",
          "const fallback = alias || '/';",
          "res.redirect(fallback);",
        ].join("\n"),
      );
      expect(ids(r.findings)).toEqual([`${R.UNVALIDATED_REDIRECT}@3`, `${R.UNVALIDATED_REDIRECT}@5`]);
    });

    it("flags Express redirect('back') as a Referer redirect", async () => {
      const r = await scan(`res.redirect('back');`);
      expect(r.findings[0].metadata!.sourceKind).toBe("referer-header");
    });

    it.each([
      ["constant", `res.redirect('/home');`],
      ["fixed path prefix", `res.redirect('/search?q=' + req.query.q);`],
      ["fixed origin template", "res.redirect(`https://docs.example.com/${req.query.page}`);"],
      ["validator wrapped", `res.redirect(safeRedirect(req.query.next));`],
      ["validator ternary", `res.redirect(isSafeRedirect(req.query.next) ? req.query.next : '/');`],
      ["sanitised variable", `const n = sanitizeRedirect(req.query.next);\nres.redirect(n);`],
      ["reassigned clean", `let n = req.query.next;\nn = '/home';\nres.redirect(n);`],
      ["commented out", `// res.redirect(req.query.next);\n/* res.redirect(req.body.x) */`],
      ["inside a string", `const doc = "res.redirect(req.query.next)";`],
      ["method declaration", `class R { redirect(url) { return url; } }`],
    ])("does not flag %s", async (_name, code) => {
      expect((await scan(code)).findings).toEqual([]);
    });

    it("treats a guard before the sink as validation", async () => {
      const code = [
        "const next = req.query.next;",
        "if (!ALLOWED.includes(new URL(next).origin)) return res.redirect('/');",
        "res.redirect(next);",
      ].join("\n");
      expect((await scan(code)).findings).toEqual([]);
    });

    it("recognises exact host comparison through a derived URL", async () => {
      const code = [
        "const raw = req.query.target;",
        "const url = new URL(raw, base);",
        "if (url.hostname !== 'app.example.com') throw new Error('bad');",
        "res.redirect(raw);",
      ].join("\n");
      expect((await scan(code)).findings).toEqual([]);
    });

    it("ignores guards further away than proximityLines", async () => {
      const filler = Array.from({ length: 5 }, () => "doWork();").join("\n");
      const code = `const next = req.query.next;\nif (!isSafeRedirect(next)) return;\n${filler}\nres.redirect(next);`;
      const near = await scan(code, "a.ts", { options: { unsafeRedirect: { proximityLines: 10 } } });
      const far = await scan(code, "a.ts", { options: { unsafeRedirect: { proximityLines: 2 } } });
      expect(near.findings).toEqual([]);
      expect(ids(far.findings)).toEqual([`${R.UNVALIDATED_REDIRECT}@8`]);
    });

    it("honours configured validators, sinks and sources", async () => {
      const code = [
        "h.redirect(event.multiValueQueryStringParameters.next);",
        "res.redirect(myCheck(req.query.a));",
      ].join("\n");
      const r = await scan(code, "handler.ts", {
        options: {
          unsafeRedirect: {
            additionalSinks: ["h.redirect"],
            additionalSources: ["event.multiValueQueryStringParameters"],
            safeValidators: ["myCheck"],
          },
        },
      });
      // h.redirect is also a built-in sink; findings are de-duplicated.
      expect(ids(r.findings)).toEqual([`${R.UNVALIDATED_REDIRECT}@1`]);
      expect(r.findings[0].metadata!.sourceKind).toBe("custom");
    });
  });

  describe("redirect-002 weak host checks", () => {
    it.each([
      [`if (url.startsWith('https://app.example.com')) ok();`, "prefix"],
      [`if (url.startsWith('//app.example.com')) ok();`, "prefix"],
      [`if (redirectUrl.startsWith('https://')) ok();`, "scheme-only"],
      [`if (new URL(next).hostname.endsWith('example.com')) ok();`, "suffix"],
      [`if (returnUrl.includes('example.com')) ok();`, "substring"],
      [`if (target.indexOf('https://example.com') !== -1) ok();`, "substring"],
    ])("flags %s", async (code, word) => {
      const r = await scan(code);
      expect(r.findings.map((f) => f.ruleId)).toEqual([R.WEAK_HOST_CHECK]);
      expect(String(r.findings[0].metadata!.reason)).toContain(word === "scheme-only" ? "scheme-only" : `${word} match`);
    });

    it.each([
      [`if (url.startsWith('https://app.example.com/')) ok();`],
      [`if (new URL(next).hostname.endsWith('.example.com')) ok();`],
      [`if (fileName.endsWith('example.com')) ok();`],
      [`if (ALLOWED.includes(url)) ok();`],
    ])("does not flag %s", async (code) => {
      expect((await scan(code)).findings).toEqual([]);
    });

    it("reports the weak check instead of an unvalidated redirect", async () => {
      const code = [
        "const next = req.query.next;",
        "if (next.includes('example.com')) {",
        "  res.redirect(next);",
        "}",
      ].join("\n");
      expect(ids((await scan(code)).findings)).toEqual([`${R.WEAK_HOST_CHECK}@2`]);
    });
  });

  describe("redirect-003 relative-path bypass", () => {
    it("flags startsWith('/') and first-character checks", async () => {
      const r = await scan(`if (next.startsWith('/')) a();\nif (returnTo[0] === '/') b();\nif (target.charAt(0) == "/") c();`);
      expect(ids(r.findings)).toEqual([
        `${R.RELATIVE_PATH_BYPASS}@1`,
        `${R.RELATIVE_PATH_BYPASS}@2`,
        `${R.RELATIVE_PATH_BYPASS}@3`,
      ]);
    });

    it("accepts a nearby protocol-relative guard", async () => {
      const code = `if (next.startsWith('//')) return false;\nreturn next.startsWith('/');`;
      expect((await scan(code)).findings).toEqual([]);
    });

    it("ignores unrelated identifiers", async () => {
      expect((await scan(`if (filePath.startsWith('/')) a();`)).findings).toEqual([]);
    });
  });

  describe("redirect-004 regex allowlists", () => {
    it.each([
      ["/https:\\/\\/example.com/.test(url)", ["missing start anchor", "unescaped '.' in host"]],
      ["/^https:\\/\\/example\\.com/.test(url)", ["host not terminated by '$', '/' or ':'"]],
      ["/^https?:\\/\\/.*example\\.com$/.test(url)", ["wildcard before host"]],
      ["next.match(/example\\.com$/)", ["missing start anchor"]],
      ["new RegExp('^https://example.com$')", ["unescaped '.' in host"]],
    ])("flags %s", async (code, reasons) => {
      const r = await scan(`const ok = ${code};`);
      expect(r.findings.map((f) => f.ruleId)).toEqual([R.UNSAFE_REGEX_ALLOWLIST]);
      expect(r.findings[0].metadata!.reasons).toEqual(expect.arrayContaining(reasons));
    });

    it.each([
      ["/^https:\\/\\/(?:www\\.)?example\\.com(?:\\/|$)/.test(url)"],
      ["/^https:\\/\\/example\\.com$/.test(url)"],
      ["/^https:\\/\\/example\\.com:\\d+$/.test(url)"],
      ["/\\.(js|ts)$/.test(fileName)"],
      ["/^[a-z]+\\.json$/.test(name)"],
    ])("does not flag %s", async (code) => {
      expect((await scan(`const ok = ${code};`)).findings).toEqual([]);
    });

    it("analyzeHostRegex returns no reasons for patterns without a host", () => {
      expect(analyzeHostRegex("^\\/[a-z]+$")).toEqual([]);
    });
  });

  describe("configuration", () => {
    const code = `res.redirect(req.query.next);\nif (url.includes('example.com')) a();`;

    it("disables rules via boolean or object config", async () => {
      const off = await scan(code, "a.ts", { rules: { [R.UNVALIDATED_REDIRECT]: false } });
      expect(off.findings.map((f) => f.ruleId)).toEqual([R.WEAK_HOST_CHECK]);
      const off2 = await scan(code, "a.ts", { rules: { [R.WEAK_HOST_CHECK]: { enabled: false } } });
      expect(off2.findings.map((f) => f.ruleId)).toEqual([R.UNVALIDATED_REDIRECT]);
    });

    it("overrides severity and updates the summary", async () => {
      const r = await scan(code, "a.ts", {
        rules: { [R.UNVALIDATED_REDIRECT]: { enabled: true, severity: Severity.CRITICAL } },
      });
      expect(r.findings[0].severity).toBe(Severity.CRITICAL);
      expect(r.summary).toEqual({ critical: 1, high: 0, medium: 1, low: 0, info: 0 });
    });

    it("caps findings with maxFindings deterministically", async () => {
      const r = await scan(code, "a.ts", { maxFindings: 1 });
      expect(ids(r.findings)).toEqual([`${R.UNVALIDATED_REDIRECT}@1`]);
    });

    it.each([
      [{ rules: { "nope-1": true } }, /Unknown rule: nope-1/],
      [{ rules: { [R.WEAK_HOST_CHECK]: { enabled: true, severity: "urgent" } } }, /unknown severity/],
      [{ maxFindings: -1 }, /maxFindings/],
      [{ options: { unsafeRedirect: "yes" } }, /must be an object/],
      [{ options: { unsafeRedirect: { proximityLines: 0 } } }, /proximityLines/],
      [{ options: { unsafeRedirect: { maxFileBytes: 1.5 } } }, /maxFileBytes/],
      [{ options: { unsafeRedirect: { safeValidators: ["ok", "bad name"] } } }, /safeValidators\[1\]/],
      [{ options: { unsafeRedirect: { additionalSinks: "h.redirect" } } }, /additionalSinks must be an array/],
      [{ options: { unsafeRedirect: { additionalSources: ["a..b"] } } }, /additionalSources\[0\]/],
      [{ options: { unsafeRedirect: { unknownKey: 1 } } }, /not a recognised option/],
    ])("rejects invalid config %#", async (config, message) => {
      const a = new UnsafeRedirectAnalyzer();
      expect(a.validateConfig(config as any).join(", ")).toMatch(message);
      await expect(a.analyze("x", "a.ts", config as any)).rejects.toThrow(/Invalid configuration/);
    });

    it("keeps working with no config at all (backward compatible)", async () => {
      const a = new UnsafeRedirectAnalyzer();
      expect(a.validateConfig({})).toEqual([]);
      await a.initialize();
      expect((await a.analyze("res.redirect(req.query.n)", "a.js")).findings).toHaveLength(1);
    });
  });

  describe("input handling", () => {
    it.each([
      ["contracts/Token.sol", /unsupported file type ".sol"/],
      ["Makefile", /unsupported file type "\(none\)"/],
    ])("reports unsupported file %s without throwing", async (file, msg) => {
      const r = await scan("res.redirect(req.query.next)", file);
      expect(r.findings).toEqual([]);
      expect(r.filesAnalyzed).toBe(0);
      expect(r.errors![0].message).toMatch(msg);
    });

    it("skips declaration files silently", async () => {
      const r = await scan("declare function redirect(u: string): void;", "types.d.ts");
      expect(r).toEqual(expect.objectContaining({ filesAnalyzed: 0, errors: undefined }));
    });

    it("rejects non-string content and empty paths as invalid input", async () => {
      const a = new UnsafeRedirectAnalyzer();
      const r1 = await a.analyze(undefined as any, "a.ts");
      const r2 = await a.analyze("x", "  ");
      expect(r1.errors![0].message).toMatch(/content must be a string/);
      expect(r2.errors![0].message).toMatch(/path must be a non-empty string/);
    });

    it("skips files above maxFileBytes at the exact boundary", async () => {
      const code = "res.redirect(req.query.n)"; // 25 bytes
      const cfg = (n: number) => ({ options: { unsafeRedirect: { maxFileBytes: n } } });
      expect((await scan(code, "a.ts", cfg(25))).findings).toHaveLength(1);
      const over = await scan(code, "a.ts", cfg(24));
      expect(over.findings).toEqual([]);
      expect(over.errors![0].message).toMatch(/25 bytes, above maxFileBytes \(24\)/);
    });

    it("counts multi-byte characters as UTF-8 bytes", async () => {
      const r = await scan("é", "a.ts", { options: { unsafeRedirect: { maxFileBytes: 1 } } });
      expect(r.errors![0].message).toMatch(/2 bytes/);
    });

    it("skips binary content", async () => {
      const r = await scan("res.redirect(req.query.n)\u0000\u0001", "a.js");
      expect(r.findings).toEqual([]);
      expect(r.errors![0].message).toMatch(/binary/);
    });

    it("handles empty files and unterminated constructs", async () => {
      expect((await scan("", "a.ts")).findings).toEqual([]);
      const r = await scan("res.redirect(req.query.next\n/* unterminated", "a.ts");
      expect(r.findings).toHaveLength(1);
    });

    it("respects excludePaths", async () => {
      const r = await scan("res.redirect(req.query.n)", "test/a.ts", { excludePaths: ["test/**"] });
      expect(r).toEqual(expect.objectContaining({ filesAnalyzed: 0, findings: [] }));
    });

    it("never puts source text or matched literals in finding messages", async () => {
      const r = await scan(
        "const next = req.query.sk_live_SECRET123;\nres.redirect(next);\nif (url.includes('internal.secret-host.example')) a();",
      );
      expect(r.findings).toHaveLength(2);
      const serialized = JSON.stringify(r.findings);
      expect(serialized).not.toContain("SECRET123");
      expect(serialized).not.toContain("secret-host");
    });
  });

  describe("multi-file analysis", () => {
    it("is deterministic regardless of input order", async () => {
      const entries: Array<[string, string]> = [
        ["b.ts", "res.redirect(req.query.b);"],
        ["a.js", "if (url.includes('x.example')) a();\nres.redirect(req.query.a);"],
        ["c.sol", "contract C {}"],
      ];
      const a = await new UnsafeRedirectAnalyzer().analyzeMultiple(new Map(entries));
      const b = await new UnsafeRedirectAnalyzer().analyzeMultiple(new Map([...entries].reverse()));
      expect(a.findings).toEqual(b.findings);
      expect(a.findings.map((f) => `${f.location.file}:${f.location.startLine}`)).toEqual([
        "a.js:1",
        "a.js:2",
        "b.ts:1",
      ]);
      expect(a.filesAnalyzed).toBe(2);
      expect(a.errors).toBeUndefined();
    });

    it("isolates per-file failures (partial results)", async () => {
      const r = await new UnsafeRedirectAnalyzer().analyzeMultiple(
        new Map([
          ["big.ts", "x".repeat(50)],
          ["ok.ts", "res.redirect(req.query.n)"],
        ]),
        { options: { unsafeRedirect: { maxFileBytes: 40 } } },
      );
      expect(r.findings.map((f) => f.location.file)).toEqual(["ok.ts"]);
      expect(r.errors).toEqual([{ file: "big.ts", message: expect.stringMatching(/maxFileBytes/) }]);
    });

    it("rejects non-Map input", async () => {
      await expect(new UnsafeRedirectAnalyzer().analyzeMultiple({} as any)).rejects.toThrow(TypeError);
    });

    it("serves unchanged files from the incremental cache with identical results", async () => {
      const a = new UnsafeRedirectAnalyzer();
      const files = new Map([["a.ts", "res.redirect(req.query.n)"]]);
      const first = await a.analyzeMultiple(files, { incremental: true });
      const second = await a.analyzeMultiple(files, { incremental: true });
      expect(second.findings).toEqual(first.findings);
      expect(second.incremental).toEqual({ cachedFiles: 1, analyzedFiles: 0, totalFiles: 1 });
    });
  });

  describe("telemetry", () => {
    it("counts analyzed and skipped files and findings per rule", async () => {
      const metrics = new RedirectAnalysisMetrics();
      const a = new UnsafeRedirectAnalyzer({ observer: metrics });
      await a.analyzeMultiple(
        new Map([
          ["a.ts", "res.redirect(req.query.n);\nres.redirect(req.body.m);"],
          ["b.sol", "contract B {}"],
          ["c.d.ts", "declare const x: string;"],
          ["d.js", "x\u0000"],
        ]),
      );
      const snap = metrics.snapshot();
      expect(snap).toEqual(
        expect.objectContaining({
          filesAnalyzed: 1,
          filesSkipped: 3,
          skippedByReason: { "unsupported-file-type": 1, "declaration-file": 1, "binary-content": 1 },
          findingsByRule: { [R.UNVALIDATED_REDIRECT]: 2 },
          totalFindings: 2,
        }),
      );
    });

    it("is not affected by a throwing observer", async () => {
      const a = new UnsafeRedirectAnalyzer({
        observer: {
          onFileAnalyzed: () => {
            throw new Error("boom");
          },
        },
      });
      const r = await a.analyze("res.redirect(req.query.n)", "a.ts");
      expect(r.findings).toHaveLength(1);
    });
  });
});
