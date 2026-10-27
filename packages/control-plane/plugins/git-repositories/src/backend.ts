import { serveGitBackend as serveRepositoryBackend, type GitBackendRequest } from "@slop-lab/gs-repository";
import type { NativeGitRoute } from "./routing.js";

type NativeBackendRequest = Omit<GitBackendRequest, "identity" | "route"> & {
  readonly identity: { readonly role: "reader"; readonly username: string }
    | { readonly role: "writer"; readonly username: string; readonly workspaceId: string };
  readonly route: NativeGitRoute;
};

export function serveGitBackend(input: NativeBackendRequest): Promise<void> {
  const { projectId, ...route } = input.route;
  const identity: GitBackendRequest["identity"] = input.identity.role === "writer"
    ? { role: "writer", username: input.identity.username, principalId: input.identity.workspaceId }
    : { role: "reader", username: input.identity.username };
  return serveRepositoryBackend({ ...input, identity, route: { ...route, namespaceId: projectId } });
}
