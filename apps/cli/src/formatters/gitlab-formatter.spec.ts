import { RuleMatch } from "./sarif-formatter";
import {
  computeGitLabFingerprint,
  toGitLabCodeQuality,
  toGitLabCodeQualityString,
  toGitLabSeverity,
} from "./gitlab-formatter";

function makeMatch(overrides: Partial<RuleMatch> = {}): RuleMatch {
  return {
    ruleId: "GG001",
    ruleName: "cached-array-length",
    message: "Cache array length outside the loop",
    file: "contracts/Token.sol",
    line: 12,
    column: 5,
    severity: "medium",
    gasSavings: 200,
    ...overrides,
  };
}

describe("gitlab-formatter", () => {
  it("produces GitLab Code Quality issues with required schema fields", () => {
    const issues = toGitLabCodeQuality([makeMatch()]);
    expect(issues).toHaveLength(1);

    const issue = issues[0];
    expect(issue.check_name).toBe("GG001");
    expect(issue.description).toBe(
      "[GG001] cached-array-length: Cache array length outside the loop",
    );
    expect(issue.severity).toBe("minor");
    expect(issue.location.path).toBe("contracts/Token.sol");
    expect(issue.location.lines.begin).toBe(12);
    expect(issue.fingerprint).toBeDefined();
    expect(typeof issue.fingerprint).toBe("string");
    expect(issue.fingerprint.length).toBe(64); // SHA-256 hex
    expect(issue.engine_name).toBe("GasGuard");
    expect(issue.categories).toContain("Gas Optimization");
    expect(issue.content?.body).toContain("200 gas units");
  });

  it("handles rule matches without ruleName or column", () => {
    const issues = toGitLabCodeQuality([
      makeMatch({ ruleName: undefined, column: undefined }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toBe(
      "[GG001] Cache array length outside the loop",
    );
  });

  it("produces deterministic fingerprints for identical findings", () => {
    const m1 = makeMatch();
    const m2 = makeMatch();
    expect(computeGitLabFingerprint(m1)).toBe(computeGitLabFingerprint(m2));

    const m3 = makeMatch({ line: 13 });
    expect(computeGitLabFingerprint(m1)).not.toBe(computeGitLabFingerprint(m3));
  });

  it("maps severities correctly to GitLab Code Quality severities", () => {
    expect(toGitLabSeverity("critical")).toBe("critical");
    expect(toGitLabSeverity("high")).toBe("major");
    expect(toGitLabSeverity("medium")).toBe("minor");
    expect(toGitLabSeverity("low")).toBe("info");
    expect(toGitLabSeverity("info")).toBe("info");
  });

  it("adds Security category to critical and high severity issues", () => {
    const issues = toGitLabCodeQuality([
      makeMatch({ severity: "critical" }),
      makeMatch({ severity: "low" }),
    ]);
    expect(issues[0].categories).toContain("Security");
    expect(issues[1].categories).not.toContain("Security");
  });

  it("formats valid JSON string", () => {
    const jsonString = toGitLabCodeQualityString([makeMatch()]);
    const parsed = JSON.parse(jsonString);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].check_name).toBe("GG001");
  });

  it("handles empty matches list gracefully", () => {
    const issues = toGitLabCodeQuality([]);
    expect(issues).toEqual([]);
    const jsonString = toGitLabCodeQualityString([]);
    expect(JSON.parse(jsonString)).toEqual([]);
  });
});
