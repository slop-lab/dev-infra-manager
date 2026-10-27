import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { executionTaskHandlerKind, type ExecutionTaskHandler } from "@slop-lab/dim-contracts-execution/plugin-api";
import { assertTracePath } from "@slop-lab/gs-review-tracing";
import type { TraceChange } from "@slop-lab/gs-review-tracing/plugin-api";
import { cleanupNodeReviewTraceExecution, createNodeReviewTraceRuntime } from "@slop-lab/gs-review-tracing-node";

const installed = await createNodeReviewTraceRuntime();
function detectorInput(raw: unknown): { entrypoint: string; changes: readonly TraceChange[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid review tracing task input");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "changes,entrypoint" || typeof value.entrypoint !== "string" || !Array.isArray(value.changes)) throw new Error("invalid review tracing task input");
  assertTracePath(value.entrypoint);
  for (const change of value.changes as unknown[]) {
    if (change === null || typeof change !== "object" || Array.isArray(change)) throw new Error("invalid review tracing change");
    const row = change as Record<string, unknown>;
    if (typeof row.status !== "string" || typeof row.oldPathBytes !== "string" || typeof row.newPathBytes !== "string" || row.oldPath !== undefined && typeof row.oldPath !== "string" || row.newPath !== undefined && typeof row.newPath !== "string") throw new Error("invalid review tracing change");
  }
  return { entrypoint: value.entrypoint, changes: value.changes as TraceChange[] };
}

export const reviewTracingTaskHandler: ExecutionTaskHandler = {
  taskType: "review-tracing", revision: createHash("sha256").update(installed.revision).update("\0").update(await readFile(new URL(import.meta.url))).digest("hex"),
  async run(input) {
    const payload = detectorInput(input.payload);
    const runtime = await createNodeReviewTraceRuntime({ ownerId: input.assignment.id });
    async function read(path: string, role: "dependency" | "target", view: "before" | "after" = "after"): Promise<Buffer | undefined> {
      assertTracePath(path);
      const raw = await input.exchange("read", { path, role, view }, input.signal);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "content") throw new Error("invalid review tracing read response");
      const content = (raw as Record<string, unknown>).content;
      if (content === null) return undefined;
      if (typeof content !== "string" || content.length > 1_398_104) throw new Error("invalid review tracing read bytes");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== content) throw new Error("invalid review tracing read bytes");
      return bytes;
    }
    const result = await runtime.evaluate({ ...payload, readFile: (path) => read(path, "dependency"),
      readTargetFile: (path, view) => read(path, "target", view), signal: input.signal });
    return result.matches;
  },
  cleanup: ({ assignment }) => cleanupNodeReviewTraceExecution(assignment.id)
};

export const hostPlugin: WorkspaceHostPlugin = {
  name: "review-tracing-node",
  extensions: [{ kind: executionTaskHandlerKind, name: reviewTracingTaskHandler.taskType, value: reviewTracingTaskHandler }]
};
