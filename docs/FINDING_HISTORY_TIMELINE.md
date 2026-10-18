# Finding History Timeline

The Finding History Timeline system (#1040) provides immutable, chronological tracking of events throughout the entire lifecycle of a gas and security finding—from initial scan detection to triage, assignment, mitigation, resolution verification, and regression tracking.

## Lifecycle Event Types

| Event Type | Description |
| :--- | :--- |
| `DETECTED` | Initial identification by the GasGuard static analysis engine |
| `REASSIGNED` | Finding ownership or assignee transitioned to an engineer or team (#1035) |
| `STATUS_CHANGED` | Lifecycle transition (`OPEN`, `IN_REVIEW`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`) |
| `SEVERITY_OVERRIDDEN` | Manual triage update to finding severity rating |
| `SUPPRESSED` | Marked as false-positive or accepted risk with reason and expiry |
| `UNSUPPRESSED` | Suppression expired or manually lifted |
| `FIX_PROPOSED` | Automated or suggested patch generated |
| `FIX_APPLIED` | Remediation code committed to branch |
| `VERIFIED_RESOLVED` | Subsequent scan or verification confirmed finding is resolved |
| `REGRESSED` | Previously resolved finding resurfaced in a subsequent build |
| `COMMENT_ADDED` | Reviewer notes, triage explanations, or audit feedback |

---

## API Usage

### 1. Recording Events

```typescript
import { FindingTimelineService } from "./src/findings/timeline";

const timeline = new FindingTimelineService();

// Record initial detection
timeline.recordDetection({
  findingId: "FINDING-42",
  organizationId: "org-1",
  file: "contracts/Vault.sol",
  line: 88,
  ruleId: "GAS-001",
  severity: "high",
  commitHash: "e4a2c1b",
});

// Record reassignment
timeline.recordReassignment({
  findingId: "FINDING-42",
  organizationId: "org-1",
  actor: "lead@example.com",
  previousAssignee: undefined,
  newAssignee: "dev@example.com",
  reason: "Vault smart contract owner",
});

// Record verified resolution
timeline.recordResolution({
  findingId: "FINDING-42",
  organizationId: "org-1",
  actor: "ci-scanner",
  verificationCommit: "f8d3e2a",
  notes: "Zero violations found in PR #114",
});
```

### 2. Querying & Metrics

```typescript
// Query full timeline in chronological order
const events = timeline.getTimeline("FINDING-42");

// Get lifecycle summary and metrics (MTTR, touches, status)
const summary = timeline.getTimelineSummary("FINDING-42");
console.log(summary.currentStatus);        // "RESOLVED"
console.log(summary.timeToResolutionMs);   // Duration from detection to fix in ms
console.log(summary.hasRegressed);         // false
```

### 3. Export Formats

The timeline service supports exporting to both structured JSON and formatted Markdown tables for audit logs and PR descriptions:

```typescript
const markdownTable = timeline.exportMarkdownTimeline("FINDING-42");
const jsonRecord = timeline.exportJsonTimeline("FINDING-42");
```
