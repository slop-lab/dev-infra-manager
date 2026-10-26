import { ControllerWorkspaces, lifecycleOptions } from "../index.js";
import { MissingRecordError, UserError } from "@slop-lab/dim-host-core";
import { ensureManagedController } from "./managed-controller.js";
import { adminErrorDetail, unixHttpRequest } from "./controller-transport.js";

export class ControllerRequestError extends UserError {
  readonly name = "ControllerRequestError";

  constructor(readonly status: number, detail: string) {
    super(`controller request failed (${status})${detail ? `: ${detail}` : ""}`);
  }
}

export async function adminCall<T = unknown>(
  operation: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<T> {
  const options = lifecycleOptions();
  await ensureManagedController(options);
  const response = await unixHttpRequest(
    options.adminControllerSocketPath,
    `/v1/call/${encodeURIComponent(operation)}`,
    { method: "POST", body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new UserError(adminErrorDetail(response.body) || `admin controller request failed (${response.status})`);
  }
  return (response.status === 204 || response.body.length === 0 ? {} : JSON.parse(response.body)) as T;
}

export async function controllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  let socketPath = process.env.DIM_CONTROLLER_SOCKET;
  let api = process.env.DIM_CONTROLLER_API;
  let token = process.env.DIM_CONTROLLER_TOKEN;
  if (workspace) {
    const options = lifecycleOptions();
    socketPath ??= options.controllerSocketPath;
    try {
      token = await new ControllerWorkspaces(options).ensureGrant(workspace);
      if (socketPath === options.controllerSocketPath) await ensureManagedController(options);
    } catch (error) {
      if (error instanceof MissingRecordError
        || (error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new UserError(`workspace '${workspace}' not found on this host`);
      }
      throw error;
    }
  }
  if ((!socketPath && !api) || !token) {
    throw new UserError(
      "DIM_CONTROLLER_SOCKET/TOKEN are required; use --workspace on the host"
    );
  }
  if (socketPath) {
    const response = await unixHttpRequest(socketPath, pathname, init, token);
    if (response.status < 200 || response.status >= 300) {
      throw new ControllerRequestError(response.status, response.body.trim());
    }
    if (response.status === 204) return {};
    return JSON.parse(response.body);
  }
  const response = await fetch(new URL(pathname, api), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new UserError(`external URL controller request failed (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
  }
  if (response.status === 204) return {};
  const body: unknown = await response.json();
  return body;
}
