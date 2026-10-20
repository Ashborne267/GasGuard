import { AsyncLocalStorage } from "async_hooks";
import {
  createChildTraceContext,
  createRootTraceContext,
  generateSpanId,
  TraceContext,
} from "./trace-context";

export interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "ok" | "error";
  tags: Record<string, string>;
  tenantId?: string;
  errorMessage?: string;
}

export class TracePropagationService {
  private readonly asyncLocalStorage = new AsyncLocalStorage<TraceContext>();
  private readonly completedSpans: ActiveSpan[] = [];
  private readonly maxCompletedSpans: number;

  constructor(maxCompletedSpans: number = 1000) {
    this.maxCompletedSpans = maxCompletedSpans;
  }

  /**
   * Returns current active trace context if present.
   */
  getActiveContext(): TraceContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Runs an asynchronous or synchronous function within the scope of a TraceContext.
   */
  async runWithContext<T>(
    context: TraceContext,
    fn: (ctx: TraceContext) => Promise<T> | T,
  ): Promise<T> {
    return this.asyncLocalStorage.run(context, () => fn(context));
  }

  /**
   * Starts a span. If an active trace context exists, links as a child span.
   * If not, initializes a new root trace context.
   */
  startSpan(
    operationName: string,
    tags: Record<string, string> = {},
    parentContext?: TraceContext,
  ): { span: ActiveSpan; context: TraceContext } {
    const activeCtx = parentContext ?? this.getActiveContext();
    let newContext: TraceContext;

    if (activeCtx) {
      newContext = createChildTraceContext(activeCtx, {
        extraBaggage: tags,
      });
    } else {
      newContext = createRootTraceContext({
        baggage: tags,
        tenantId: tags.tenantId,
      });
    }

    const span: ActiveSpan = {
      traceId: newContext.traceId,
      spanId: newContext.spanId,
      parentId: newContext.parentId,
      operationName,
      startTime: Date.now(),
      status: "ok",
      tags: { ...newContext.baggage, ...tags },
      tenantId: newContext.tenantId,
    };

    return { span, context: newContext };
  }

  /**
   * Ends a span and records duration and completion status.
   */
  endSpan(
    span: ActiveSpan,
    status: "ok" | "error" = "ok",
    errorMessage?: string,
  ): ActiveSpan {
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
    if (errorMessage) {
      span.errorMessage = errorMessage;
    }

    this.completedSpans.push(span);
    if (this.completedSpans.length > this.maxCompletedSpans) {
      this.completedSpans.shift();
    }

    return span;
  }

  getCompletedSpans(): ActiveSpan[] {
    return [...this.completedSpans];
  }

  clearSpans(): void {
    this.completedSpans.length = 0;
  }
}

export const defaultTraceService = new TracePropagationService();
