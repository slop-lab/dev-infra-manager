import { packageVersion } from "./package-version.js";

export function workspaceImageReference(override: string | undefined): string {
  return override ?? `dev-infra-project-workspace:${packageVersion}`;
}
