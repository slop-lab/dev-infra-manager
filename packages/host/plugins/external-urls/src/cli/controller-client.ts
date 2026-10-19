import { lifecycleOptions } from "@slop-lab/dim-host-core/controller";
import { UserError } from "@slop-lab/dim-host-core";
import { controllerRequest, ensureManagedController, unixHttpRequest } from "@slop-lab/dim-host-core/controller/cli";
export async function externalUrlControllerRequest(
  pathname: string,
  init: RequestInit = {},
  workspace?: string
): Promise<unknown> {
  return controllerRequest(pathname, init, workspace);
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
        "External URL commands require the @slop-lab/dim-host-plugin-external-urls plugin; install it and restart the controller"
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
