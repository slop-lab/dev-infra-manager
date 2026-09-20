import { readFile } from "node:fs/promises";
import path from "node:path";
import { lifecycleOptions, UserError } from "@slop-lab/dim-core";
import { ensureManagedController } from "./managed-controller.js";
import { adminErrorDetail, unixHttpRequest } from "./controller-transport.js";

export async function externalUrlControllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  return controllerRequest(pathname, init, workspace);
}

export class WorkspaceControllerGrantNotFoundError extends UserError {
  readonly name = "WorkspaceControllerGrantNotFoundError";
}

export class ControllerRequestError extends UserError {
  readonly name = "ControllerRequestError";

  constructor(readonly status: number, detail: string) {
    super(`controller request failed (${status})${detail ? `: ${detail}` : ""}`);
  }
}

export async function adminCall<T = unknown>(
  operation: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const options = lifecycleOptions();
  await ensureManagedController(options);
  const response = await unixHttpRequest(
    options.adminControllerSocketPath,
    `/v1/call/${encodeURIComponent(operation)}`,
    { method: "POST", body: JSON.stringify(body) }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new UserError(adminErrorDetail(response.body) || `admin controller request failed (${response.status})`);
  }
  return (response.status === 204 || response.body.length === 0 ? {} : JSON.parse(response.body)) as T;
}

export async function externalUrlAdmin<T = unknown>(
  action: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const options = lifecycleOptions();
  await ensureManagedController(options);
  const response = await unixHttpRequest(
    options.adminControllerSocketPath,
    `/v1/external-url/${encodeURIComponent(action)}`,
    { method: "POST", body: JSON.stringify(body) }
  );
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) {
      throw new UserError(
        "External URL commands require the @slop-lab/dim-plugin-external-urls plugin; install it and restart the controller"
      );
    }
    const detail = externalUrlErrorDetail(response.body);
    throw new UserError(
      `External URL admin request failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  return (response.status === 204 || response.body.length === 0 ? {} : JSON.parse(response.body)) as T;
}

export function externalUrlErrorDetail(body: string): string {
  if (body.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Preserve a non-JSON response from the controller for diagnostics.
  }
  return body.trim();
}

export async function controllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  let socketPath = process.env.DIM_CONTROLLER_SOCKET ?? process.env.DIM_AGENT_CONTROLLER_SOCKET;
  let api = process.env.DIM_CONTROLLER_API;
  let token = process.env.DIM_CONTROLLER_TOKEN ?? process.env.DIM_AGENT_CONTROLLER_TOKEN;
  if (workspace) {
    const options = lifecycleOptions();
    socketPath ??= options.controllerSocketPath;
    try {
      token = (await readFile(path.join(options.stateRoot, "workspace-grants", workspace), "utf8")).trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new WorkspaceControllerGrantNotFoundError(`workspace '${workspace}' has no controller grant`);
      }
      throw error;
    }
  }
  if ((!socketPath && !api) || !token) {
    throw new UserError(
      "DIM_CONTROLLER_SOCKET/TOKEN or DIM_AGENT_CONTROLLER_SOCKET/TOKEN are required inside a workspace; use --workspace on the host"
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
