import type { IncomingMessage } from "node:http";

export type RepositoryOperation = "read" | "write";

export type RepositoryRoute = {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly pathInfo: string;
  readonly queryString: string;
  readonly operation: RepositoryOperation;
};

const routePattern = /^\/v1\/namespaces\/([^/]+)\/repositories\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const identifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function repositoryRoute(request: Pick<IncomingMessage, "method" | "url" | "headers">): RepositoryRoute | undefined {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://gs.invalid");
  const match = routePattern.exec(url.pathname);
  if (match === null) return undefined;
  const projectId = decodedIdentifier(match[1]);
  const repositoryId = decodedIdentifier(match[2]);
  const endpoint = match[3];
  if (projectId === undefined || repositoryId === undefined || endpoint === undefined) return undefined;

  if (method === "GET" && endpoint === "info/refs") {
    if (url.searchParams.size !== 1) return undefined;
    const service = url.searchParams.get("service");
    if (service === "git-upload-pack" || service === "git-receive-pack") {
      return route(projectId, repositoryId, endpoint, `service=${service}`, service === "git-upload-pack" ? "read" : "write");
    }
    return undefined;
  }
  if (method === "POST" && url.search === "" && endpoint === "git-upload-pack"
    && request.headers["content-type"] === "application/x-git-upload-pack-request") {
    return route(projectId, repositoryId, endpoint, "", "read");
  }
  if (method === "POST" && url.search === "" && endpoint === "git-receive-pack"
    && request.headers["content-type"] === "application/x-git-receive-pack-request") {
    return route(projectId, repositoryId, endpoint, "", "write");
  }
  return undefined;
}

function route(
  projectId: string,
  repositoryId: string,
  endpoint: string,
  queryString: string,
  operation: RepositoryOperation
): RepositoryRoute {
  return {
    namespaceId: projectId,
    repositoryId,
    pathInfo: `/${projectId}/${repositoryId}.git/${endpoint}`,
    queryString,
    operation
  };
}

function decodedIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return identifierPattern.test(decoded) ? decoded : undefined;
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}
