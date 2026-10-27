import type { IncomingMessage } from "node:http";
import { repositoryRoute, type RepositoryRoute, type RepositoryOperation } from "@slop-lab/gs-repository";

export type NativeGitOperation = RepositoryOperation;
export type NativeGitRoute = Omit<RepositoryRoute, "namespaceId"> & { readonly projectId: string };

export function nativeGitRoute(request: IncomingMessage): NativeGitRoute | undefined {
  const url = request.url;
  if (!url?.startsWith("/v1/projects/")) return undefined;
  const parsed = repositoryRoute({ method: request.method, headers: request.headers,
    url: url.replace(/^\/v1\/projects\//, "/v1/namespaces/") });
  if (!parsed) return undefined;
  const { namespaceId, ...route } = parsed;
  return { ...route, projectId: namespaceId };
}
