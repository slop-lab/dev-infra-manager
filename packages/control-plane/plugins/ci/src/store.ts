import { executionSummary, executionSummaryRowSchema, type ExecutionSummary } from "@slop-lab/dim-contracts-ci/query";
import { executionEventSchema, executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import { executionResultSchema, parseExecution, type Execution, type ExecutionAssignment, type ExecutionEvent,
  type ExecutionGrant, type ExecutionResult, type ExecutionProfile, type WorkerSlot } from "@slop-lab/dim-contracts-ci/aggregate";
import { TaskStore, assertSchedulingIndexes, taskEventSchema, taskGrantSchema, taskResultSchema, taskJobSchema,
  type TaskEvent, type TaskProfile, type TaskGrant, type TaskResult, type TaskExecution, type TaskAssignment, type ScheduledSlot } from "@slop-lab/dim-task-scheduling";

export type ScheduledExecution = Execution | TaskExecution;
export type ScheduledExecutionAssignment = ExecutionAssignment | TaskAssignment;
function taskValue(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const kind: unknown = Reflect.get(value, "executionKind");
  return typeof kind === "string" && kind.startsWith("task/");
}
export function parseScheduledJob(value: unknown): ScheduledExecution {
  return value !== null && typeof value === "object" && taskValue(Reflect.get(value, "event")) ? taskJobSchema.parse(value) : parseExecution(value);
}
/** CI and plugin tasks share one queue, lease authority and occupied-slot index. */
export class ExecutionStore extends TaskStore<ExecutionEvent | TaskEvent, ExecutionProfile | TaskProfile,
  ExecutionGrant | TaskGrant, ExecutionResult | TaskResult, ScheduledExecution> {
  constructor(path: string, generationId: string, leaseMilliseconds: number, now: () => number = Date.now) {
    super(path, generationId, leaseMilliseconds, {
      parseEvent(value) { return taskValue(value) ? taskEventSchema.parse(value) : executionEventSchema.parse(value); },
      parseGrant(value) { return value !== null && typeof value === "object" && taskValue(Reflect.get(value, "event")) ? taskGrantSchema.parse(value) : executionGrantSchema.parse(value); },
      parseResult(value) { const task = taskResultSchema.safeParse(value); return task.success ? task.data : executionResultSchema.parse(value); },
      matchesProfile(event, profile) { return !taskValue(event) || Reflect.get(event, "handlerRevision") === Reflect.get(profile, "handlerRevision") && Reflect.get(event, "taskType") === Reflect.get(profile, "taskType"); },
      parseJob: parseScheduledJob
    }, now);
  }
  override enqueue(input: ExecutionEvent): Execution;
  override enqueue(input: TaskEvent): TaskExecution;
  override enqueue(input: ExecutionEvent | TaskEvent): ScheduledExecution;
  override enqueue(input: ExecutionEvent | TaskEvent): ScheduledExecution { return super.enqueue(input); }
  override reserve(workerId: string, slot: WorkerSlot, requestId: string): ExecutionAssignment | undefined;
  override reserve(workerId: string, slot: ScheduledSlot<TaskProfile>, requestId: string): TaskAssignment | undefined;
  override reserve(workerId: string, slot: ScheduledSlot<ExecutionProfile | TaskProfile>, requestId: string): ScheduledExecutionAssignment | undefined;
  override reserve(workerId: string, slot: ScheduledSlot<ExecutionProfile | TaskProfile>, requestId: string): ScheduledExecutionAssignment | undefined { return super.reserve(workerId, slot, requestId); }
  override attachGrant(id: string, grant: ExecutionGrant): ExecutionAssignment;
  override attachGrant(id: string, grant: TaskGrant): TaskAssignment;
  override attachGrant(id: string, grant: ExecutionGrant | TaskGrant): ScheduledExecutionAssignment;
  override attachGrant(id: string, grant: ExecutionGrant | TaskGrant): ScheduledExecutionAssignment { return super.attachGrant(id, grant); }
  recentSummaries(): ExecutionSummary[] {
    // Drop task records and large diagnostics in SQLite before decoding CI summaries.
    return this.database.prepare("SELECT id,event_id,generation_id,phase,worker_id,slot_id,request_id,created_at,retry_of,execution_kind,publication,lease_expires_at,json_remove(body,'$.result.logs','$.grant','$.leaseToken','$.profile') AS body FROM executions WHERE execution_kind NOT LIKE 'task/%' ORDER BY created_at DESC,rowid DESC LIMIT 100")
      .all().map((row) => {
        const value = executionSummaryRowSchema.parse(JSON.parse(String(row.body)));
        assertSchedulingIndexes(row, value); return executionSummary(value);
      });
  }
}
