import type { GitCiRuntime } from "./runtime.js";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { GitCiConfig } from "./config.js";
import { authorizeExecution, assertCurrentExecution, readExecutionGrant, recordExecutionEvidence, ExecutionConflictError } from "./execution-evidence.js";
import { executionGrantRequestSchema, type ExecutionGrant } from "@slop-lab/dim-contracts-ci/execution";
import { AuthoritativeRepositoryError, nativeBasicAuthorized, nativeBasicCredential } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { readBoundedJson, sendJson, sendNotFound, NativeGitBundleHttpError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { serveGitBackend } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { NativeGitRoute } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

type Input = { readonly config: GitCiConfig; readonly runtime: GitCiRuntime;
  readonly stateDirectory: string; readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => number };
export type ExecutionHttpService = ReturnType<typeof createExecutionHttpService>;
export function createExecutionHttpService(input: Input) {
  const now = input.now ?? Date.now;
  const leases = new Map<string, { password: string; expiresAt: number; grant: ExecutionGrant }>();
  const prune = () => { for (const [id, lease] of leases) if (lease.expiresAt <= now()) leases.delete(id); };
  return {
    close() { leases.clear(); },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      const grantRoute = url.pathname === "/v1/execution-grants";
      const match = /^\/v1\/executions\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})\/([0-9a-f-]{36})\/(evidence|read-lease)$/.exec(url.pathname);
      if (!grantRoute && match === null) return false;
      if (request.method !== "POST" || url.search !== "") { sendNotFound(response); return true; }
      const role = grantRoute ? input.config.grantIssuer
        : match?.[4] === "evidence" ? input.config.resultReporter : input.config.candidateReader;
      if (!nativeBasicAuthorized(request, role)) { sendJson(response, 401, { error: "unauthorized" }); return true; }
      if (!input.runtime.activated() || request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
        sendJson(response, 409, { error: "execution generation is unavailable" }); return true;
      }
      try {
        const body = await readBoundedJson(request);
        const result = await input.serialize(async () => {
          if (grantRoute) return authorizeExecution(input.runtime, executionGrantRequestSchema.parse(body));
          const projectId = match![1]!;
          const repositoryId = match![2]!;
          const grant = await readExecutionGrant(join(input.stateDirectory, projectId, `${repositoryId}.git`), match![3]!);
          if (grant === undefined || grant.event.projectId !== projectId || grant.event.repositoryId !== repositoryId) throw new ExecutionConflictError("execution was not found");
          if (match![4] === "evidence") return recordExecutionEvidence(input.runtime, grant, body);
          z.object({}).strict().parse(body);
          await assertCurrentExecution(input.runtime, grant);
          prune();
          const username = `execution-${randomBytes(18).toString("hex")}`;
          const password = randomBytes(32).toString("base64url");
          const expiresAt = now() + 30_000;
          leases.set(username, { password, expiresAt, grant });
          return { username, password, expiresAt };
        });
        sendJson(response, 201, result);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "execution request is invalid" });
        else if (error instanceof ExecutionConflictError || error instanceof CandidateExecutionError || error instanceof AuthoritativeRepositoryError) {
          sendJson(response, 409, { error: "execution source or attempt is stale" });
        } else if (error instanceof Error) sendJson(response, 503, { error: "execution authority is unavailable" });
        else throw error;
      }
      return true;
    },
    async serveGit(request: IncomingMessage, response: ServerResponse, route: NativeGitRoute): Promise<boolean> {
      const supplied = nativeBasicCredential(request);
      if (supplied === undefined) return false;
      prune();
      const lease = leases.get(supplied.username);
      if (lease === undefined) return false;
      const actual = Buffer.from(supplied.password), expected = Buffer.from(lease.password);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return true; }
      if (route.operation !== "read" || route.projectId !== lease.grant.event.projectId || !Object.hasOwn(lease.grant.descriptor.inputs, route.repositoryId)) {
        response.writeHead(403).end(); return true;
      }
      try { await input.serialize(() => assertCurrentExecution(input.runtime, lease.grant)); }
      catch { response.writeHead(409).end(); return true; }
      await serveGitBackend({ config: { gitExecutable: input.runtime.gitExecutable, storageRoot: input.stateDirectory },
        identity: { role: "reader", username: "execution-reader" }, route, request, response });
      return true;
    }
  };
}
