/**
 * Resumable interrupted scans (issue #1196).
 *
 * A long scan advances through stages (discover, parse, analyze, report) and
 * processes many items per stage. If the worker is interrupted, the checkpoint
 * records the furthest point reached so the scan can resume instead of starting
 * over.
 *
 * Progress within a stage must be monotonic: a checkpoint may not move backwards
 * for the same stage, so a late or duplicated write cannot cause already-scanned
 * items to be reprocessed. Moving to a new stage resets the item counter, which
 * is allowed because the new stage starts its own progress.
 */

export interface ScanCheckpoint {
  scanId: string;
  stage: string;
  /** Items completed in `stage` so far. */
  processed: number;
  /** Total items in `stage`; `0` means the stage is a single unit of work. */
  total: number;
  updatedAt: number;
}

export interface ResumePoint {
  stage: string;
  /** Index the worker should resume from (equals `processed`). */
  nextIndex: number;
  total: number;
  complete: boolean;
}

export class ScanCheckpointStore {
  private readonly checkpoints: Map<string, ScanCheckpoint> = new Map();

  /**
   * Record progress for a scan.
   *
   * Overwrites any earlier checkpoint for the same scan. Rejects progress that
   * moves backwards within the same stage, and rejects counts that are negative
   * or imply more processed items than the stage contains.
   */
  save(
    scanId: string,
    stage: string,
    processed: number,
    total: number,
    now: number = Date.now(),
  ): ScanCheckpoint {
    requireNonEmpty(scanId, "scanId");
    requireNonEmpty(stage, "stage");
    requireNonNegativeInteger(processed, "processed");
    requireNonNegativeInteger(total, "total");
    if (processed > total) {
      throw new RangeError("processed cannot exceed total");
    }

    const existing = this.checkpoints.get(scanId);
    if (existing && existing.stage === stage && processed < existing.processed) {
      throw new RangeError("checkpoint cannot move backwards within a stage");
    }

    const checkpoint: ScanCheckpoint = {
      scanId,
      stage,
      processed,
      total,
      updatedAt: now,
    };
    this.checkpoints.set(scanId, checkpoint);
    return { ...checkpoint };
  }

  /** The current checkpoint for a scan, if any. */
  get(scanId: string): ScanCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(scanId);
    return checkpoint ? { ...checkpoint } : undefined;
  }

  /**
   * The point from which to resume a scan, or undefined when it was never
   * checkpointed. A stage with `total === 0` is complete as soon as it is
   * recorded.
   */
  resumeFrom(scanId: string): ResumePoint | undefined {
    const checkpoint = this.checkpoints.get(scanId);
    if (!checkpoint) {
      return undefined;
    }
    const complete =
      checkpoint.total === 0 || checkpoint.processed >= checkpoint.total;
    return {
      stage: checkpoint.stage,
      nextIndex: checkpoint.processed,
      total: checkpoint.total,
      complete,
    };
  }

  /** Whether the current stage has no remaining work. */
  isComplete(scanId: string): boolean {
    return this.resumeFrom(scanId)?.complete ?? false;
  }

  /** Drop the checkpoint for a scan. Returns whether one existed. */
  clear(scanId: string): boolean {
    return this.checkpoints.delete(scanId);
  }

  /** Number of scans with a stored checkpoint. */
  size(): number {
    return this.checkpoints.size;
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}
