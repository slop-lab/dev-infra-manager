import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { ControllerWorkspaces } from "./controllerWorkspace.js";
import { lifecycleOptions } from "./lifecycleOptions.js";

/** Host-only adapter: the scoped grant remains here, never in an agent's configuration. */
export async function workspacePluginRequest(
  workspace: Pick<WorkspaceRecord, "name" | "id">,
  pathname: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  signal: AbortSignal
): Promise<unknown> {
  if (!/^\/api\/[a-z0-9/-]+$/.test(pathname)) throw new UserError("invalid workspace plugin path");
  const options = lifecycleOptions();
  const token = await new ControllerWorkspaces(options).ensureGrant(workspace.name, workspace.id);
  const { ensureManagedController } = await import("./cli/managed-controller.js");
  const { unixHttpRequest } = await import("./cli/controller-transport.js");
  await ensureManagedController(options);
  const response = await unixHttpRequest(options.controllerSocketPath, pathname, {
    method: init.method, signal,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  }, token);
  if (response.status < 200 || response.status >= 300) throw new UserError(`workspace plugin request failed (${response.status}): ${response.body.slice(0, 1024)}`);
  return response.body.length ? JSON.parse(response.body) as unknown : {};
}
