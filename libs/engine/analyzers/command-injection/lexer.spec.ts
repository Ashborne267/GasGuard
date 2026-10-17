import { LineIndex, maskComments, readCallArgs } from "./lexer";

describe("command-injection lexer", () => {
  it("masks comments while preserving offsets", () => {
    const src = "const x = 1; // comment\nconst y = 2;";
    const masked = maskComments(src);
    expect(masked.length).toBe(src.length);
    expect(masked).not.toContain("// comment");
    expect(masked).toContain("const x = 1;");
  });

  it("extracts nested arguments from call expressions", () => {
    const src = "exec('ping ' + host, { timeout: 1000 })";
    const openParen = src.indexOf("(") + 1;
    const res = readCallArgs(src, openParen);
    expect(res.args).toHaveLength(2);
    expect(res.args[0].text).toBe("'ping ' + host");
  });

  it("indexes lines and columns accurately", () => {
    const idx = new LineIndex("hello\nworld");
    expect(idx.position(0)).toEqual({ line: 1, column: 1 });
    expect(idx.position(6)).toEqual({ line: 2, column: 1 });
  });
});
