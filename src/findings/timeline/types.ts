/**
 * Types for Finding History Timeline (#1040).
 *
 * Defines domain events, lifecycle statuses, timeline records, filter criteria,
 * and aggregated summary statistics across the complete lifecycle of a finding.
 */

export type FindingLifecycleStatus =
  | "OPEN"
  | "IN_REVIEW"
  | "IN_PROGRESS"
  | "SUPPRESSED"
  | "RESOLVED"
  | "CLOSED"
  | "REGRESSED";

export type FindingEventType =
  | "DETECTED"
  | "STATUS_CHANGED"
  | "REASSIGNED"
  | "SEVERITY_OVERRIDDEN"
  | "SUPPRESSED"
  | "UNSUPPRESSED"
  | "FIX_PROPOSED"
  | "FIX_APPLIED"
  | "VERIFIED_RESOLVED"
  | "REGRESSED"
  | "COMMENT_ADDED";

export interface FindingTimelineEvent {
  id: string;
  findingId: string;
  organizationId: string;
  type: FindingEventType;
  timestamp: number; // epoch ms
  actor: string;
  summary: string;
  details?: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  commitHash?: string;
  branch?: string;
}

export interface RecordEventInput {
  findingId: string;
  organizationId: string;
  type: FindingEventType;
  actor: string;
  summary: string;
  timestamp?: number;
  details?: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  commitHash?: string;
  branch?: string;
}

export interface TimelineFilter {
  organizationId: string;
  findingId?: string;
  eventTypes?: FindingEventType[];
  actors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface FindingTimelineSummary {
  findingId: string;
  organizationId: string;
  currentStatus: FindingLifecycleStatus;
  currentAssignee?: string;
  initialDetectedAt: number;
  lastUpdatedAt: number;
  totalEvents: number;
  reassignmentCount: number;
  suppressionCount: number;
  hasRegressed: boolean;
  timeToFirstTriageMs?: number;
  timeToResolutionMs?: number;
}
