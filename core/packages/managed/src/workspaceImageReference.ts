import { packageVersion } from "./package-version.js";

/** Managed workspaces require the controller and relay assets of their own image. */
export function workspaceImageReference(override: string | undefined): string {
  return override ?? `dev-infra-managed-workspace:${packageVersion}`;
}
