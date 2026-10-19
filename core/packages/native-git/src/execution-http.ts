import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { authorizeExecution, assertCurrentExecution, readExecutionGrant, recordExecutionEvidence, ExecutionConflictError } from "./execution-evidence.js";
import { executionGrantRequestSchema, type ExecutionGrant } from "./execution-protocol.js";
import { nativeBasicAuthorized, nativeBasicCredential } from "./native-basic-auth.js";
import { readBoundedJson, sendJson, sendNotFound, NativeGitBundleHttpError } from "./native-bundle-http.js";
import { serveGitBackend } from "./backend.js";
import type { NativeGitRoute } from "./routing.js";

type Input = { readonly config: NativeGitBundleConfig; readonly runtime: AuthoritativeNativeCandidateRuntime;
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
      const role = grantRoute ? input.config.ci.grantIssuer
        : match?.[4] === "evidence" ? input.config.ci.resultReporter : input.config.ci.candidateReader;
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
        else if (error instanceof ExecutionConflictError || error instanceof CandidateExecutionError) {
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
