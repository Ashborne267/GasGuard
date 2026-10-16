/**
 * Integration: representative repositories through the registry and the
 * engine's safe runner (component boundary used by API workers).
 */
import * as fs from "fs";
import * as path from "path";
import { AnalyzerRegistry } from "../../core/analyzer-registry";
import { runAnalyzerSafely, runAnalyzers } from "../../core/analyzer-runner";
import { Language } from "../../core/analyzer-interface";
import { RustAnalyzer } from "../rust-analyzer";
import { UNSAFE_REDIRECT_RULES as R, UnsafeRedirectAnalyzer } from "./index";

const FIXTURES = path.resolve(__dirname, "../../../../tests/fixtures/unsafe-redirect");

function loadRepo(name: string): Map<string, string> {
  const root = path.join(FIXTURES, name);
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return files;
}

async function findingsFor(repo: string): Promise<string[]> {
  const result = await new UnsafeRedirectAnalyzer().analyzeMultiple(loadRepo(repo));
  return result.findings.map((f) => `${f.location.file}:${f.location.startLine} ${f.ruleId}`);
}

describe("UnsafeRedirectAnalyzer on representative repositories", () => {
  it("express-app: server redirects, weak helpers, mixed languages", async () => {
    expect(await findingsFor("express-app")).toEqual([
      `src/routes/account.js:15 ${R.UNVALIDATED_REDIRECT}`,
      `src/routes/auth.js:7 ${R.UNVALIDATED_REDIRECT}`,
      `src/routes/auth.js:13 ${R.UNVALIDATED_REDIRECT}`,
      `src/routes/auth.js:18 ${R.UNVALIDATED_REDIRECT}`,
      `src/routes/auth.js:29 ${R.RELATIVE_PATH_BYPASS}`,
      `src/utils/redirect.ts:5 ${R.WEAK_HOST_CHECK}`,
      `src/utils/redirect.ts:7 ${R.UNSAFE_REGEX_ALLOWLIST}`,
      `src/utils/redirect.ts:11 ${R.WEAK_HOST_CHECK}`,
    ]);
  });

  it("nextjs-app: route handlers, middleware and client components", async () => {
    expect(await findingsFor("nextjs-app")).toEqual([
      `app/login/route.ts:6 ${R.UNVALIDATED_REDIRECT}`,
      `components/Callback.tsx:11 ${R.UNVALIDATED_REDIRECT}`,
      `lib/allowlist.ts:4 ${R.WEAK_HOST_CHECK}`,
      `lib/allowlist.ts:6 ${R.UNSAFE_REGEX_ALLOWLIST}`,
      `lib/allowlist.ts:10 ${R.RELATIVE_PATH_BYPASS}`,
    ]);
  });

  it("node-service: Koa, Fastify and raw http", async () => {
    expect(await findingsFor("node-service")).toEqual([
      `src/fastify.ts:8 ${R.UNVALIDATED_REDIRECT}`,
      `src/koa.js:6 ${R.UNVALIDATED_REDIRECT}`,
      `src/server.mjs:8 ${R.UNVALIDATED_REDIRECT}`,
    ]);
  });

  it("safe-app: correct validation produces no findings", async () => {
    expect(await findingsFor("safe-app")).toEqual([]);
  });

  it("produces byte-identical results across repeated runs", async () => {
    const files = loadRepo("express-app");
    const a = await new UnsafeRedirectAnalyzer().analyzeMultiple(files);
    const b = await new UnsafeRedirectAnalyzer().analyzeMultiple(new Map([...files].reverse()));
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings));
  });

  it("registers alongside existing analyzers and is selected by language", () => {
    const registry = new AnalyzerRegistry();
    registry.register(new RustAnalyzer());
    registry.register(new UnsafeRedirectAnalyzer());
    expect(registry.getAnalyzersForLanguage(Language.TYPESCRIPT).map((a) => a.getName())).toEqual([
      "UnsafeRedirectAnalyzer",
    ]);
    expect(registry.getAnalyzersForLanguage(Language.RUST).map((a) => a.getName())).toEqual([
      "RustAnalyzer",
    ]);
  });

  it("runs under the safe runner next to other analyzers without coupling", async () => {
    const files = loadRepo("express-app");
    const { results, diagnostics } = await runAnalyzers(
      [new RustAnalyzer(), new UnsafeRedirectAnalyzer()],
      files,
    );
    expect(diagnostics).toEqual([]);
    expect(results[1].findings).toHaveLength(8);
    expect(results[1].filesAnalyzed).toBe(3);
  });

  it("degrades a timeout to an empty result with a diagnostic", async () => {
    const analyzer = new UnsafeRedirectAnalyzer();
    jest
      .spyOn(analyzer, "analyzeMultiple")
      .mockImplementation(() => new Promise(() => undefined));
    const outcome = await runAnalyzerSafely(analyzer, loadRepo("safe-app"), { timeoutMs: 10 });
    expect(outcome.diagnostic).toEqual(
      expect.objectContaining({ kind: "timeout", analyzer: "UnsafeRedirectAnalyzer", timeoutMs: 10 }),
    );
    expect(outcome.result.findings).toEqual([]);
  });

  it("surfaces invalid configuration as an error diagnostic", async () => {
    const outcome = await runAnalyzerSafely(new UnsafeRedirectAnalyzer(), loadRepo("safe-app"), {
      options: { unsafeRedirect: { proximityLines: -1 } },
    });
    expect(outcome.diagnostic).toEqual(expect.objectContaining({ kind: "error" }));
    expect(outcome.diagnostic!.message).toMatch(/proximityLines/);
  });
});
