import { isDeepStrictEqual } from "node:util";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { timingSafeEqual } from "node:crypto";
import { nativeWorkspaceBrokerRuntimeRevision } from "./nativeWorkspaceBrokerRuntime.js";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { createNativeGitWorkspaceWriteIssuerClient } from "./nativeGitWorkspaceWriteIssuerClient.js";
import { nativeWorkspaceAttachmentFile, nativeWorkspaceBrokerHealth, readNativeWorkspaceAttachment, type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

const brokerRequestTimeoutMilliseconds = 145_000;
const readinessTimeoutMilliseconds = 40_000;
const leaseTimeoutMilliseconds = 35_000;
const upstreamTimeoutMilliseconds = 65_000;

/** A scoped Git endpoint. It has no lifecycle, plugin, host-input or administrative routes. */
export function createNativeWorkspaceBroker(attachment: NativeWorkspaceAttachment): Server {
  const store = new WorkspaceStore(attachment.workspaceStateRoot);
  const server = createServer(async (request, response) => {
    const disconnected = new AbortController();
    const abortDisconnected = () => disconnected.abort(new NativeWorkspaceBrokerRequestError("native workspace Git request disconnected"));
    request.once("aborted", abortDisconnected);
    response.once("close", abortDisconnected);
    const requestSignal = AbortSignal.any([
      disconnected.signal,
      AbortSignal.timeout(brokerRequestTimeoutMilliseconds)
    ]);
    try {
      const url = new URL(request.url ?? "/", "http://dim.invalid");
      const match = /^\/v1\/projects\/([a-z0-9-]+)\/repositories\/([a-z0-9][a-z0-9-]*)\.git(?:\/|$)/.exec(url.pathname);
      const health = request.method === "GET" && url.pathname === "/health" && url.search === "";
      const repositoryId = match?.[2], repository = repositoryId === undefined ? undefined : attachment.repositories[repositoryId];
      if (!health && (match?.[1] !== attachment.projectId || !repository)) { response.writeHead(404).end(); return; }
      const grant = health ? Object.values(attachment.repositories)[0]?.grant : repository?.grant;
      if (!grant) { response.writeHead(404).end(); return; }
      const expected = Buffer.from(`Basic ${Buffer.from(`dim:${grant}`).toString("base64")}`), actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401, { "www-authenticate": 'Basic realm="DIM workspace Git"' }).end(); return; }
      let workspace: WorkspaceRecord;
      try { workspace = await store.read(attachment.workspaceName); } catch { response.writeHead(410).end(); return; }
      if (workspace.id !== attachment.workspaceId || workspace.phase === "discarding") { response.writeHead(410).end(); return; }
      if (health) {
        response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "x-dim-native-git-runtime": nativeWorkspaceBrokerRuntimeRevision }).end(nativeWorkspaceBrokerHealth(attachment)); return;
      }
      if (!workspace.initialized || workspace.phase !== "running") { response.writeHead(409).end(); return; }
      if (!repository || !repositoryId) { response.writeHead(404).end(); return; }
      const base = `/v1/projects/${attachment.projectId}/repositories/${repositoryId}.git`;
      const endpoint = url.pathname.slice(base.length);
      const discovery = request.method === "GET" && url.pathname === `${base}/info/refs`
        && new URLSearchParams(url.search).size === 1
        && ["git-upload-pack", "git-receive-pack"].includes(new URLSearchParams(url.search).get("service") ?? "");
      const protocol = request.method === "POST" && url.search === "" && url.pathname.startsWith(base)
        && ((endpoint === "/git-upload-pack" && request.headers["content-type"] === "application/x-git-upload-pack-request")
          || (endpoint === "/git-receive-pack" && request.headers["content-type"] === "application/x-git-receive-pack-request"));
      if (!discovery && !protocol) { response.writeHead(404).end(); return; }
      // A verified reconnect updates only this private host-side reference. The running
      // broker retains its original UUID, scope and workspace credential.
      const current = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(attachment.managedStateRoot, attachment.workspaceId));
      if (!isDeepStrictEqual(immutableAttachmentScope(attachment), immutableAttachmentScope(current))) {
        response.writeHead(409).end(); return;
      }
      const connection = await loadNativeControlPlaneConnection(current.connectionFile);
      const project = await new NativeProjectPendingStore(attachment.managedStateRoot).read(attachment.projectName, connection.hostId);
      const configuredRepository = project?.repositories[repositoryId];
      if (project?.phase !== "ready" || project.projectId !== attachment.projectId
        || !configuredRepository || !Object.hasOwn(nativeRepositoryBranches(configuredRepository.repositoryPolicy), repository.protectedRef)) { response.writeHead(409).end(); return; }
      const proof = await proveNativeProjectReadiness(connection, project, repositoryId, AbortSignal.any([
        requestSignal,
        AbortSignal.timeout(readinessTimeoutMilliseconds)
      ]), {
        commit: repository.commit, tree: repository.tree, protectedRef: repository.protectedRef, allowFastForward: true
      });
      // Readiness authenticates the catalog's effective policy on every request.
      // Existing grants keep their scope while the authority enforces the new policy.
      const lease = await createNativeGitWorkspaceWriteIssuerClient({ schemaVersion: 1, endpoint: connection.nativeGit.endpoint,
        serviceId: "native-main", role: "operator-workspace-write-issuer", hostId: connection.hostId,
        generationId: proof.generationId, credential: connection.nativeGit.workspaceWriteIssuer
      }).issueWorkspaceWriteLease({ projectId: attachment.projectId, repositoryId, workspaceId: repository.nativeWorkspaceId }, AbortSignal.any([
        requestSignal,
        AbortSignal.timeout(leaseTimeoutMilliseconds)
      ]));
      const target = new URL(`${url.pathname}${url.search}`, connection.nativeGit.endpoint);
      await new Promise<void>((resolve) => {
        const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
          method: request.method, signal: AbortSignal.any([
            requestSignal,
            AbortSignal.timeout(upstreamTimeoutMilliseconds)
          ]), headers: {
            authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`,
            ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
            ...(request.headers["git-protocol"] ? { "git-protocol": request.headers["git-protocol"] } : {})
          }
        }, (incoming) => {
          if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) {
            incoming.destroy(); response.writeHead(502).end(); resolve(); return;
          }
          response.writeHead(incoming.statusCode ?? 502, {
            ...(incoming.headers["content-type"] ? { "content-type": incoming.headers["content-type"] } : {}), "cache-control": "no-store"
          });
          incoming.once("end", resolve);
          incoming.once("error", resolve);
          incoming.pipe(response);
        });
        upstream.on("error", () => {
          if (!response.destroyed) {
            if (!response.headersSent) response.writeHead(502);
            response.end();
          }
          resolve();
        });
        request.pipe(upstream);
      });
    } catch {
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      }
    } finally {
      request.off("aborted", abortDisconnected);
      response.off("close", abortDisconnected);
    }
  });
  server.requestTimeout = 150_000; server.headersTimeout = 10_000;
  return server;
}

/** Policy revisions and connection paths are refreshable host metadata, never Git scope. */
function immutableAttachmentScope(attachment: NativeWorkspaceAttachment): unknown {
  const withoutRevision = <T extends { policyRevision: string }>(binding: T): Omit<T, "policyRevision"> => {
    const { policyRevision: _revision, ...scope } = binding;
    return scope;
  };
  return { ...attachment, connectionFile: "", configuration: withoutRevision(attachment.configuration),
    repositories: Object.fromEntries(Object.entries(attachment.repositories).map(([id, binding]) => [id, withoutRevision(binding)])) };
}

class NativeWorkspaceBrokerRequestError extends Error {
  readonly name = "NativeWorkspaceBrokerRequestError";
}
