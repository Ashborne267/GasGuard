import { FindingTimelineService } from "./finding-timeline.service";

describe("FindingTimelineService (#1040)", () => {
  let service: FindingTimelineService;

  beforeEach(() => {
    service = new FindingTimelineService();
  });

  afterEach(() => {
    service.clear();
  });

  const orgId = "org-123";
  const findingId = "finding-abc-456";

  describe("Event Recording & Validation", () => {
    it("records a custom event with auto-generated id and defaults", () => {
      const event = service.recordEvent({
        findingId,
        organizationId: orgId,
        type: "COMMENT_ADDED",
        actor: "auditor@example.com",
        summary: "Needs triage before sprint end",
      });

      expect(event.id).toBeDefined();
      expect(event.findingId).toBe(findingId);
      expect(event.organizationId).toBe(orgId);
      expect(event.type).toBe("COMMENT_ADDED");
      expect(event.actor).toBe("auditor@example.com");
      expect(event.summary).toBe("Needs triage before sprint end");
      expect(typeof event.timestamp).toBe("number");
    });

    it("throws when missing findingId, organizationId, actor, or summary", () => {
      expect(() =>
        service.recordEvent({
          findingId: "",
          organizationId: orgId,
          type: "DETECTED",
          actor: "system",
          summary: "test",
        }),
      ).toThrow("findingId is required");

      expect(() =>
        service.recordEvent({
          findingId,
          organizationId: "",
          type: "DETECTED",
          actor: "system",
          summary: "test",
        }),
      ).toThrow("organizationId is required");

      expect(() =>
        service.recordEvent({
          findingId,
          organizationId: orgId,
          type: "DETECTED",
          actor: "",
          summary: "test",
        }),
      ).toThrow("actor is required");

      expect(() =>
        service.recordEvent({
          findingId,
          organizationId: orgId,
          type: "DETECTED",
          actor: "system",
          summary: "",
        }),
      ).toThrow("summary is required");
    });
  });

  describe("Lifecycle Timeline Flow", () => {
    it("tracks complete finding lifecycle from detection to resolution", () => {
      const t0 = 1700000000000;
      const t1 = t0 + 60000; // 1 min later
      const t2 = t0 + 120000; // 2 min later
      const t3 = t0 + 180000; // 3 min later
      const t4 = t0 + 240000; // 4 min later

      service.recordDetection({
        findingId,
        organizationId: orgId,
        file: "contracts/Vault.sol",
        line: 88,
        ruleId: "GAS-001",
        severity: "high",
        commitHash: "a1b2c3d4",
        timestamp: t0,
      });

      service.recordReassignment({
        findingId,
        organizationId: orgId,
        actor: "lead@example.com",
        previousAssignee: undefined,
        newAssignee: "dev1@example.com",
        reason: "Primary smart contract engineer for Vault module",
        timestamp: t1,
      });

      service.recordStatusChange({
        findingId,
        organizationId: orgId,
        actor: "dev1@example.com",
        from: "OPEN",
        to: "IN_PROGRESS",
        reason: "Working on storage packing refactor",
        timestamp: t2,
      });

      service.recordFixApplied({
        findingId,
        organizationId: orgId,
        actor: "dev1@example.com",
        commitHash: "e5f6a7b8",
        description: "Packed storage slot variables into single uint256",
        timestamp: t3,
      });

      service.recordResolution({
        findingId,
        organizationId: orgId,
        actor: "ci-scanner",
        verificationCommit: "e5f6a7b8",
        notes: "Scan passed with 0 violations",
        timestamp: t4,
      });

      const timeline = service.getTimeline(findingId);
      expect(timeline).toHaveLength(5);
      expect(timeline.map((e) => e.type)).toEqual([
        "DETECTED",
        "REASSIGNED",
        "STATUS_CHANGED",
        "FIX_APPLIED",
        "VERIFIED_RESOLVED",
      ]);

      const summary = service.getTimelineSummary(findingId);
      expect(summary.currentStatus).toBe("RESOLVED");
      expect(summary.currentAssignee).toBe("dev1@example.com");
      expect(summary.reassignmentCount).toBe(1);
      expect(summary.hasRegressed).toBe(false);
      expect(summary.timeToFirstTriageMs).toBe(60000);
      expect(summary.timeToResolutionMs).toBe(240000);
    });

    it("tracks suppression and unsuppression lifecycle events", () => {
      service.recordDetection({
        findingId,
        organizationId: orgId,
        file: "contracts/Token.sol",
        line: 15,
        ruleId: "GAS-002",
        severity: "medium",
        timestamp: 1000,
      });

      service.recordSuppression({
        findingId,
        organizationId: orgId,
        actor: "auditor@example.com",
        reason: "Accepted risk: assembly block requires precise slot layout",
        expiresAt: 200000,
        timestamp: 2000,
      });

      let summary = service.getTimelineSummary(findingId);
      expect(summary.currentStatus).toBe("SUPPRESSED");
      expect(summary.suppressionCount).toBe(1);

      service.recordUnsuppression({
        findingId,
        organizationId: orgId,
        actor: "auditor@example.com",
        reason: "Code was refactored, re-evaluating finding",
        timestamp: 3000,
      });

      summary = service.getTimelineSummary(findingId);
      expect(summary.currentStatus).toBe("OPEN");
      expect(summary.suppressionCount).toBe(1);
    });

    it("tracks regressions when a resolved finding resurfaces", () => {
      service.recordDetection({
        findingId,
        organizationId: orgId,
        file: "contracts/Token.sol",
        line: 15,
        ruleId: "GAS-002",
        severity: "medium",
        timestamp: 1000,
      });

      service.recordResolution({
        findingId,
        organizationId: orgId,
        timestamp: 2000,
      });

      service.recordRegression({
        findingId,
        organizationId: orgId,
        commitHash: "badcommit1",
        notes: "Unoptimized loop re-introduced in pull request #45",
        timestamp: 3000,
      });

      const summary = service.getTimelineSummary(findingId);
      expect(summary.currentStatus).toBe("REGRESSED");
      expect(summary.hasRegressed).toBe(true);
    });
  });

  describe("Querying & Filtering", () => {
    beforeEach(() => {
      service.recordDetection({
        findingId: "F1",
        organizationId: orgId,
        file: "A.sol",
        line: 1,
        ruleId: "R1",
        severity: "high",
        actor: "scanner",
        timestamp: 100,
      });
      service.recordComment({
        findingId: "F1",
        organizationId: orgId,
        actor: "alice",
        comment: "Comment on F1",
        timestamp: 200,
      });
      service.recordDetection({
        findingId: "F2",
        organizationId: orgId,
        file: "B.sol",
        line: 5,
        ruleId: "R2",
        severity: "low",
        actor: "scanner",
        timestamp: 300,
      });
      service.recordComment({
        findingId: "F2",
        organizationId: "other-org",
        actor: "bob",
        comment: "Other org finding",
        timestamp: 400,
      });
    });

    it("filters by organizationId", () => {
      const results = service.queryTimeline({ organizationId: orgId });
      expect(results).toHaveLength(3);
      expect(results.every((e) => e.organizationId === orgId)).toBe(true);
    });

    it("filters by findingId", () => {
      const results = service.queryTimeline({
        organizationId: orgId,
        findingId: "F1",
      });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.findingId === "F1")).toBe(true);
    });

    it("filters by eventTypes", () => {
      const results = service.queryTimeline({
        organizationId: orgId,
        eventTypes: ["COMMENT_ADDED"],
      });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("COMMENT_ADDED");
      expect(results[0].actor).toBe("alice");
    });

    it("filters by actors and timestamp window", () => {
      const results = service.queryTimeline({
        organizationId: orgId,
        actors: ["scanner"],
        since: 150,
        until: 350,
      });
      expect(results).toHaveLength(1);
      expect(results[0].findingId).toBe("F2");
    });

    it("supports pagination with limit and offset", () => {
      const page1 = service.queryTimeline({
        organizationId: orgId,
        limit: 2,
        offset: 0,
      });
      const page2 = service.queryTimeline({
        organizationId: orgId,
        limit: 2,
        offset: 2,
      });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page1[0].timestamp).toBeLessThan(page1[1].timestamp);
      expect(page1[1].timestamp).toBeLessThan(page2[0].timestamp);
    });
  });

  describe("Export Formatting", () => {
    beforeEach(() => {
      service.recordDetection({
        findingId,
        organizationId: orgId,
        file: "contracts/Vault.sol",
        line: 10,
        ruleId: "GAS-001",
        severity: "high",
        commitHash: "1234567890",
        timestamp: 1700000000000,
      });
      service.recordComment({
        findingId,
        organizationId: orgId,
        actor: "lead",
        comment: "Checked and approved",
        timestamp: 1700000060000,
      });
    });

    it("exports Markdown timeline table", () => {
      const md = service.exportMarkdownTimeline(findingId);
      expect(md).toContain(`# Finding Timeline: ${findingId}`);
      expect(md).toContain("| Timestamp (UTC) | Event | Actor | Summary | Commit |");
      expect(md).toContain("`DETECTED`");
      expect(md).toContain("`1234567`");
      expect(md).toContain("Checked and approved");
    });

    it("exports JSON timeline with summary and event list", () => {
      const jsonStr = service.exportJsonTimeline(findingId);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.summary).toBeDefined();
      expect(parsed.summary.findingId).toBe(findingId);
      expect(parsed.events).toHaveLength(2);
    });

    it("throws when generating summary for unknown finding", () => {
      expect(() => service.getTimelineSummary("unknown-id")).toThrow(
        "No timeline events found",
      );
    });
  });
});
