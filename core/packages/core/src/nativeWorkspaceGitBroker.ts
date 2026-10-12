import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { createNativeGitWorkspaceWriteIssuerClient } from "./nativeGitWorkspaceWriteIssuerClient.js";
import type { NativeWorkspaceRecord } from "./lifecycleTypes.js";

export type NativeWorkspaceGitRequest = {
  readonly stateRoot: string;
  readonly connection: NativeControlPlaneConnection;
  readonly workspace: NativeWorkspaceRecord;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly now?: () => number;
};

export async function serveNativeWorkspaceGit(input: NativeWorkspaceGitRequest): Promise<void> {
  const { stateRoot, connection, workspace, request, response, url } = input;
  const upstreamPath = url.pathname.slice("/api/native-git".length);
  if (!allowed(request.method, upstreamPath, url.search, request.headers["content-type"])) {
    response.writeHead(404).end();
    return;
  }
  const project = await new NativeProjectPendingStore(stateRoot).read(workspace.projectName, connection.hostId);
  if (project?.phase !== "ready" || project.projectId !== workspace.source.snapshot.projectId
    || project.protectedRef !== workspace.source.snapshot.protectedRef
    || project.reviewPolicy.policyRevision !== workspace.source.policyRevision
    || project.reviewPolicy.requiredReviewRevision !== workspace.source.requiredReviewRevision
    || project.reviewPolicy.requiredJobSetRevision !== workspace.source.requiredJobSetRevision) {
    response.writeHead(409).end();
    return;
  }
  let readiness;
  try {
    readiness = await proveNativeProjectReadiness(connection, project, AbortSignal.timeout(5_000), {
      commit: workspace.source.snapshot.commit,
      tree: workspace.source.snapshot.tree,
      allowFastForward: true
    });
  } catch {
    response.writeHead(409).end();
    return;
  }
  if (readiness.commit !== workspace.source.snapshot.commit
    || readiness.tree !== workspace.source.snapshot.tree) {
    response.writeHead(409).end();
    return;
  }
  const issuer = createNativeGitWorkspaceWriteIssuerClient({
    schemaVersion: 1, endpoint: connection.nativeGit.endpoint, serviceId: "native-main",
    role: "operator-workspace-write-issuer", hostId: connection.hostId,
    generationId: readiness.generationId,
    credential: connection.nativeGit.workspaceWriteIssuer
  }, undefined, input.now ?? Date.now);
  const lease = await issuer.issueWorkspaceWriteLease({
    projectId: project.projectId, repositoryId: "root", workspaceId: workspace.workspaceId
  }, AbortSignal.timeout(5_000));
  const endpoint = new URL(connection.nativeGit.endpoint);
  const target = new URL(`${upstreamPath}${url.search}`, endpoint);
  const sendRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = sendRequest(target, {
    method: request.method,
    headers: {
      authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`, "utf8").toString("base64")}`,
      ...(request.headers["content-type"] === undefined ? {} : { "content-type": request.headers["content-type"] }),
      ...(request.headers["git-protocol"] === undefined ? {} : { "git-protocol": request.headers["git-protocol"] })
    },
    signal: AbortSignal.timeout(25_000)
  }, (upstreamResponse) => {
    if ((upstreamResponse.statusCode ?? 500) >= 300 && (upstreamResponse.statusCode ?? 500) < 400) {
      upstreamResponse.destroy();
      response.writeHead(502).end();
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      ...(upstreamResponse.headers["content-type"] === undefined ? {} : { "content-type": upstreamResponse.headers["content-type"] }),
      ...(upstreamResponse.headers["cache-control"] === undefined ? {} : { "cache-control": upstreamResponse.headers["cache-control"] })
    });
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

function allowed(method: string | undefined, path: string, search: string, contentType: string | undefined): boolean {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
    .exec(path);
  const endpoint = match?.[2];
  if (method === "GET" && endpoint === "info/refs") {
    const query = new URLSearchParams(search);
    return query.size === 1 && (query.get("service") === "git-upload-pack"
      || query.get("service") === "git-receive-pack");
  }
  if (method !== "POST" || search !== "") return false;
  return (endpoint === "git-upload-pack" && contentType === "application/x-git-upload-pack-request")
    || (endpoint === "git-receive-pack" && contentType === "application/x-git-receive-pack-request");
}
