import { randomUUID } from "crypto";
import {
  FindingEventType,
  FindingLifecycleStatus,
  FindingTimelineEvent,
  FindingTimelineSummary,
  RecordEventInput,
  TimelineFilter,
} from "./types";

export class FindingTimelineService {
  private readonly events: FindingTimelineEvent[] = [];

  /**
   * Records an immutable event in the finding history timeline.
   */
  public recordEvent(input: RecordEventInput): FindingTimelineEvent {
    if (!input.findingId?.trim()) {
      throw new Error("findingId is required to record a timeline event.");
    }
    if (!input.organizationId?.trim()) {
      throw new Error("organizationId is required to record a timeline event.");
    }
    if (!input.actor?.trim()) {
      throw new Error("actor is required to record a timeline event.");
    }
    if (!input.summary?.trim()) {
      throw new Error("summary is required to record a timeline event.");
    }

    const event: FindingTimelineEvent = {
      id: randomUUID(),
      findingId: input.findingId.trim(),
      organizationId: input.organizationId.trim(),
      type: input.type,
      timestamp: input.timestamp ?? Date.now(),
      actor: input.actor.trim(),
      summary: input.summary.trim(),
      details: input.details ? { ...input.details } : undefined,
      previousState: input.previousState ? { ...input.previousState } : undefined,
      newState: input.newState ? { ...input.newState } : undefined,
      commitHash: input.commitHash,
      branch: input.branch,
    };

    this.events.push(event);
    return event;
  }

  /**
   * Helper to record initial finding detection.
   */
  public recordDetection(params: {
    findingId: string;
    organizationId: string;
    actor?: string;
    file: string;
    line: number;
    ruleId: string;
    severity: string;
    commitHash?: string;
    branch?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "DETECTED",
      actor: params.actor ?? "gasguard-analyzer",
      summary: `Detected violation of rule ${params.ruleId} at ${params.file}:${params.line}`,
      timestamp: params.timestamp,
      details: {
        file: params.file,
        line: params.line,
        ruleId: params.ruleId,
        severity: params.severity,
      },
      newState: { status: "OPEN" },
      commitHash: params.commitHash,
      branch: params.branch,
    });
  }

  /**
   * Helper to record lifecycle status transition.
   */
  public recordStatusChange(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    from: FindingLifecycleStatus;
    to: FindingLifecycleStatus;
    reason?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "STATUS_CHANGED",
      actor: params.actor,
      summary: `Status updated from ${params.from} to ${params.to}${params.reason ? `: ${params.reason}` : ""}`,
      timestamp: params.timestamp,
      previousState: { status: params.from },
      newState: { status: params.to },
      details: params.reason ? { reason: params.reason } : undefined,
    });
  }

  /**
   * Helper to record finding reassignment (#1035 integration).
   */
  public recordReassignment(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    previousAssignee?: string;
    newAssignee: string;
    reason: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "REASSIGNED",
      actor: params.actor,
      summary: `Reassigned from ${params.previousAssignee ?? "unassigned"} to ${params.newAssignee}: ${params.reason}`,
      timestamp: params.timestamp,
      previousState: { assignee: params.previousAssignee },
      newState: { assignee: params.newAssignee },
      details: {
        previousAssignee: params.previousAssignee,
        newAssignee: params.newAssignee,
        reason: params.reason,
      },
    });
  }

  /**
   * Helper to record finding suppression.
   */
  public recordSuppression(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    reason: string;
    expiresAt?: number;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "SUPPRESSED",
      actor: params.actor,
      summary: `Suppressed finding: ${params.reason}`,
      timestamp: params.timestamp,
      previousState: { status: "OPEN" },
      newState: { status: "SUPPRESSED" },
      details: {
        reason: params.reason,
        expiresAt: params.expiresAt,
      },
    });
  }

  /**
   * Helper to record unsuppression.
   */
  public recordUnsuppression(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    reason?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "UNSUPPRESSED",
      actor: params.actor,
      summary: `Unsuppressed finding${params.reason ? `: ${params.reason}` : ""}`,
      timestamp: params.timestamp,
      previousState: { status: "SUPPRESSED" },
      newState: { status: "OPEN" },
      details: params.reason ? { reason: params.reason } : undefined,
    });
  }

  /**
   * Helper to record fix applied.
   */
  public recordFixApplied(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    commitHash?: string;
    description?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "FIX_APPLIED",
      actor: params.actor,
      summary: `Fix applied${params.description ? `: ${params.description}` : ""}`,
      timestamp: params.timestamp,
      commitHash: params.commitHash,
      newState: { status: "RESOLVED" },
    });
  }

  /**
   * Helper to record verification that finding is resolved.
   */
  public recordResolution(params: {
    findingId: string;
    organizationId: string;
    actor?: string;
    verificationCommit?: string;
    notes?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "VERIFIED_RESOLVED",
      actor: params.actor ?? "gasguard-analyzer",
      summary: `Verified resolved in build/scan${params.notes ? `: ${params.notes}` : ""}`,
      timestamp: params.timestamp,
      commitHash: params.verificationCommit,
      newState: { status: "RESOLVED" },
      details: params.notes ? { notes: params.notes } : undefined,
    });
  }

  /**
   * Helper to record regression of previously resolved finding.
   */
  public recordRegression(params: {
    findingId: string;
    organizationId: string;
    actor?: string;
    commitHash?: string;
    notes?: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "REGRESSED",
      actor: params.actor ?? "gasguard-analyzer",
      summary: `Finding regressed in scan${params.notes ? `: ${params.notes}` : ""}`,
      timestamp: params.timestamp,
      commitHash: params.commitHash,
      previousState: { status: "RESOLVED" },
      newState: { status: "REGRESSED" },
      details: params.notes ? { notes: params.notes } : undefined,
    });
  }

  /**
   * Helper to record reviewer / triage comment.
   */
  public recordComment(params: {
    findingId: string;
    organizationId: string;
    actor: string;
    comment: string;
    timestamp?: number;
  }): FindingTimelineEvent {
    return this.recordEvent({
      findingId: params.findingId,
      organizationId: params.organizationId,
      type: "COMMENT_ADDED",
      actor: params.actor,
      summary: params.comment,
      timestamp: params.timestamp,
      details: { comment: params.comment },
    });
  }

  /**
   * Returns all timeline events for a finding in chronological order.
   */
  public getTimeline(findingId: string): FindingTimelineEvent[] {
    return this.events
      .filter((e) => e.findingId === findingId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Queries timeline events matching specified filter criteria.
   */
  public queryTimeline(filter: TimelineFilter): FindingTimelineEvent[] {
    let result = this.events.filter(
      (e) => e.organizationId === filter.organizationId,
    );

    if (filter.findingId) {
      result = result.filter((e) => e.findingId === filter.findingId);
    }
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      const typeSet = new Set(filter.eventTypes);
      result = result.filter((e) => typeSet.has(e.type));
    }
    if (filter.actors && filter.actors.length > 0) {
      const actorSet = new Set(filter.actors);
      result = result.filter((e) => actorSet.has(e.actor));
    }
    if (filter.since !== undefined) {
      result = result.filter((e) => e.timestamp >= filter.since!);
    }
    if (filter.until !== undefined) {
      result = result.filter((e) => e.timestamp <= filter.until!);
    }

    result.sort((a, b) => a.timestamp - b.timestamp);

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  /**
   * Derives lifecycle summary and key operational metrics from the timeline.
   */
  public getTimelineSummary(findingId: string): FindingTimelineSummary {
    const timeline = this.getTimeline(findingId);
    if (timeline.length === 0) {
      throw new Error(`No timeline events found for findingId: ${findingId}`);
    }

    const firstEvent = timeline[0];
    const lastEvent = timeline[timeline.length - 1];
    const organizationId = firstEvent.organizationId;

    let currentStatus: FindingLifecycleStatus = "OPEN";
    let currentAssignee: string | undefined;
    let reassignmentCount = 0;
    let suppressionCount = 0;
    let hasRegressed = false;
    let firstTriageTime: number | undefined;
    let resolutionTime: number | undefined;

    for (const event of timeline) {
      if (event.newState?.status) {
        currentStatus = event.newState.status as FindingLifecycleStatus;
      }
      if (event.newState?.assignee !== undefined) {
        currentAssignee = event.newState.assignee as string;
      }

      if (event.type === "REASSIGNED") {
        reassignmentCount++;
      } else if (event.type === "SUPPRESSED") {
        suppressionCount++;
      } else if (event.type === "REGRESSED") {
        hasRegressed = true;
      }

      // First human/triage action after initial detection
      if (
        event.type !== "DETECTED" &&
        firstTriageTime === undefined &&
        event.timestamp >= firstEvent.timestamp
      ) {
        firstTriageTime = event.timestamp;
      }

      // Track resolution
      if (event.type === "VERIFIED_RESOLVED" || event.type === "FIX_APPLIED") {
        resolutionTime = event.timestamp;
      }
    }

    const timeToFirstTriageMs =
      firstTriageTime !== undefined
        ? Math.max(0, firstTriageTime - firstEvent.timestamp)
        : undefined;

    const timeToResolutionMs =
      resolutionTime !== undefined
        ? Math.max(0, resolutionTime - firstEvent.timestamp)
        : undefined;

    return {
      findingId,
      organizationId,
      currentStatus,
      currentAssignee,
      initialDetectedAt: firstEvent.timestamp,
      lastUpdatedAt: lastEvent.timestamp,
      totalEvents: timeline.length,
      reassignmentCount,
      suppressionCount,
      hasRegressed,
      timeToFirstTriageMs,
      timeToResolutionMs,
    };
  }

  /**
   * Generates a readable Markdown timeline table.
   */
  public exportMarkdownTimeline(findingId: string): string {
    const timeline = this.getTimeline(findingId);
    const summary = this.getTimelineSummary(findingId);

    const lines: string[] = [
      `# Finding Timeline: ${findingId}`,
      "",
      `- **Current Status**: \`${summary.currentStatus}\``,
      `- **Current Assignee**: \`${summary.currentAssignee ?? "Unassigned"}\``,
      `- **Initial Detection**: ${new Date(summary.initialDetectedAt).toISOString()}`,
      `- **Last Updated**: ${new Date(summary.lastUpdatedAt).toISOString()}`,
      `- **Total Events**: ${summary.totalEvents}`,
      `- **Reassignments**: ${summary.reassignmentCount}`,
      `- **Regressions**: ${summary.hasRegressed ? "Yes" : "No"}`,
      "",
      "| Timestamp (UTC) | Event | Actor | Summary | Commit |",
      "| :--- | :--- | :--- | :--- | :--- |",
    ];

    for (const event of timeline) {
      const dateStr = new Date(event.timestamp).toISOString();
      const commit = event.commitHash ? `\`${event.commitHash.slice(0, 7)}\`` : "-";
      lines.push(
        `| ${dateStr} | \`${event.type}\` | ${event.actor} | ${event.summary.replace(/\|/g, "\\|")} | ${commit} |`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  /**
   * Serializes the timeline and its summary into structured JSON.
   */
  public exportJsonTimeline(findingId: string): string {
    const timeline = this.getTimeline(findingId);
    const summary = this.getTimelineSummary(findingId);
    return `${JSON.stringify({ summary, events: timeline }, null, 2)}\n`;
  }

  /**
   * Clears internal state (primarily for test tear-downs).
   */
  public clear(): void {
    this.events.length = 0;
  }
}
