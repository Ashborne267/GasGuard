import {
  LineIndex,
  maskComments,
  maskStringContents,
  readCallArgs,
  readExpression,
} from "./lexer";

describe("unsafe-redirect lexer", () => {
  it("blanks comments but keeps strings, regexes and offsets", () => {
    const code = `a(); // res.redirect(x)\nconst u = "http://x"; /* c */ const r = /\\/\\//;`;
    const masked = maskComments(code);
    expect(masked).toHaveLength(code.length);
    expect(masked).not.toContain("res.redirect");
    expect(masked).not.toContain("/* c */");
    expect(masked).toContain(`"http://x"`);
    expect(masked).toContain("/\\/\\//");
    expect(masked.split("\n")).toHaveLength(2);
  });

  it("treats a slash after an identifier as division", () => {
    const code = "const half = total / 2; // note";
    expect(maskComments(code).trimEnd()).toBe("const half = total / 2;");
  });

  it("masks string contents but keeps template holes", () => {
    expect(maskStringContents("'abc' + `x${next}y`")).toBe("'   ' + ` ${next} `");
  });

  it("reads call arguments with nesting and strings", () => {
    const text = `f(a, g(b, c), "x,y")`;
    const { args } = readCallArgs(text, 2);
    expect(args.map((a) => a.text)).toEqual(["a", "g(b, c)", `"x,y"`]);
  });

  it("reads expressions across operator-continued lines", () => {
    expect(readExpression("a ||\n  b;\nc", 0)).toBe("a ||\n  b");
    expect(readExpression("a\nb", 0)).toBe("a");
    expect(readExpression("\n  a, b", 0)).toBe("a");
  });

  it("maps offsets to 1-based positions", () => {
    const idx = new LineIndex("ab\ncd");
    expect(idx.position(0)).toEqual({ line: 1, column: 1 });
    expect(idx.position(4)).toEqual({ line: 2, column: 2 });
  });
});
