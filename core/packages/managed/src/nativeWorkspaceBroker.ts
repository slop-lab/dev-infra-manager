import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { WorkspaceStore, type WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import { loadNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { createNativeGitWorkspaceWriteIssuerClient } from "./nativeGitWorkspaceWriteIssuerClient.js";
import { nativeWorkspaceBrokerHealth, type NativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";

/** A scoped Git endpoint. It has no lifecycle, plugin, host-input or administrative routes. */
export function createNativeWorkspaceBroker(attachment: NativeWorkspaceAttachment): Server {
  const store = new WorkspaceStore(attachment.workspaceStateRoot);
  const server = createServer(async (request, response) => {
    try {
      const expected = Buffer.from(`Basic ${Buffer.from(`dim:${attachment.grant}`).toString("base64")}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401, { "www-authenticate": 'Basic realm="DIM workspace Git"' }).end(); return; }
      let workspace: WorkspaceRecord;
      try { workspace = await store.read(attachment.workspaceName); } catch { response.writeHead(410).end(); return; }
      if (workspace.id !== attachment.workspaceId || workspace.phase === "discarding") { response.writeHead(410).end(); return; }
      const url = new URL(request.url ?? "/", "http://dim.invalid");
      if (request.method === "GET" && url.pathname === "/health" && url.search === "") {
        response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(nativeWorkspaceBrokerHealth(attachment)); return;
      }
      if (!workspace.initialized || workspace.phase !== "running") { response.writeHead(409).end(); return; }
      const base = `/v1/projects/${attachment.projectId}/repositories/root.git`;
      const endpoint = url.pathname.slice(base.length);
      const discovery = request.method === "GET" && url.pathname === `${base}/info/refs`
        && new URLSearchParams(url.search).size === 1
        && ["git-upload-pack", "git-receive-pack"].includes(new URLSearchParams(url.search).get("service") ?? "");
      const protocol = request.method === "POST" && url.search === "" && url.pathname.startsWith(base)
        && ((endpoint === "/git-upload-pack" && request.headers["content-type"] === "application/x-git-upload-pack-request")
          || (endpoint === "/git-receive-pack" && request.headers["content-type"] === "application/x-git-receive-pack-request"));
      if (!discovery && !protocol) { response.writeHead(404).end(); return; }
      const connection = await loadNativeControlPlaneConnection(attachment.connectionFile);
      const project = await new NativeProjectPendingStore(attachment.managedStateRoot).read(attachment.projectName, connection.hostId);
      if (project?.phase !== "ready" || project.projectId !== attachment.projectId) { response.writeHead(409).end(); return; }
      const proof = await proveNativeProjectReadiness(connection, project, AbortSignal.timeout(5000), {
        commit: attachment.commit, tree: attachment.tree, allowFastForward: true
      });
      if (proof.commit !== attachment.commit || proof.tree !== attachment.tree || proof.policyRevision !== attachment.policyRevision
        || proof.requiredReviewRevision !== attachment.requiredReviewRevision || proof.requiredJobSetRevision !== attachment.requiredJobSetRevision) {
        response.writeHead(409).end(); return;
      }
      const lease = await createNativeGitWorkspaceWriteIssuerClient({ schemaVersion: 1, endpoint: connection.nativeGit.endpoint,
        serviceId: "native-main", role: "operator-workspace-write-issuer", hostId: connection.hostId,
        generationId: proof.generationId, credential: connection.nativeGit.workspaceWriteIssuer
      }).issueWorkspaceWriteLease({ projectId: attachment.projectId, repositoryId: "root", workspaceId: attachment.nativeWorkspaceId }, AbortSignal.timeout(5000));
      const target = new URL(`${url.pathname}${url.search}`, connection.nativeGit.endpoint);
      const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: request.method, signal: AbortSignal.timeout(30_000), headers: {
          authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}`,
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
          ...(request.headers["git-protocol"] ? { "git-protocol": request.headers["git-protocol"] } : {})
        }
      }, (incoming) => {
        if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) { incoming.destroy(); response.writeHead(502).end(); return; }
        response.writeHead(incoming.statusCode ?? 502, {
          ...(incoming.headers["content-type"] ? { "content-type": incoming.headers["content-type"] } : {}), "cache-control": "no-store"
        }); incoming.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on("aborted", () => upstream.destroy());
      response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
      request.pipe(upstream);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  server.requestTimeout = 35_000; server.headersTimeout = 10_000;
  return server;
}
