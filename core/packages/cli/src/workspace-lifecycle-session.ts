import { UserError } from "@slop-lab/dim-core";
import type { AdminStreamOptions } from "./cli-progress.js";
import { adminStreamCall } from "./controller-session.js";

const doctorGuidance = "Run 'dim doctor' to check host readiness.";

type WorkspaceLifecycleOperation =
  | "workspace.create"
  | "workspace.setup"
  | "workspace.update"
  | "workspace.start"
  | "workspace.restart";

export async function workspaceLifecycleStreamCall<T = unknown>(
  operation: WorkspaceLifecycleOperation,
  body: Record<string, unknown> = {},
  options: AdminStreamOptions = {}
): Promise<T> {
  try {
    return await adminStreamCall<T>(operation, body, options);
  } catch (error) {
    if (!(error instanceof UserError) || error.message.includes(doctorGuidance)) throw error;
    throw new UserError(`${error.message}\n${doctorGuidance}`, { cause: error });
  }
}
