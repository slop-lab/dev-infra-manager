import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-ci/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-ci/http";
import { executionGrantSchema, executionResultSchema } from "@slop-lab/dim-contracts-ci/execution";
import type { ExecutionAssignment, ExecutionGrant, ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";

type Credential = { readonly username: string; readonly password: string };
export type ExecutionSource = {
  authorize(assignment: ExecutionAssignment): Promise<ExecutionGrant>;
  candidate(grant: ExecutionGrant): Promise<{ username: string; password: string; expiresAt: number }>;
  publish(grant: ExecutionGrant, result: ExecutionResult): Promise<void>;
};
export function nativeGitExecutionSource(config: {
  readonly endpoint: string; readonly grantIssuer: Credential; readonly candidateReader: Credential;
  readonly resultReporter: Credential;
}, generationId: string, client: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()): ExecutionSource {
  async function post(path: string, body: unknown, credential: Credential): Promise<unknown> {
    const response = await client.request({ endpoint: config.endpoint, path, method: "POST", generationId,
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (response.statusCode === 404 || response.statusCode === 409) throw new StaleExecutionSourceError();
    if (response.statusCode !== 201 || response.contentType !== "application/json" || response.cacheControl !== "no-store") {
      throw new Error("Git execution authority is unavailable");
    }
    return JSON.parse(response.body.toString("utf8"));
  }
  return {
    async authorize(assignment) {
      return executionGrantSchema.parse(await post("/v1/execution-grants", { executionId: assignment.id,
        generationId, event: assignment.event, workerId: assignment.workerId, slotId: assignment.slotId,
        profile: assignment.profile }, config.grantIssuer));
    },
    async candidate(grant) {
      const result = await post(`/v1/executions/${grant.event.projectId}/${grant.event.repositoryId}/${grant.executionId}/read-lease`, {}, config.candidateReader);
      if (result === null || typeof result !== "object" || typeof Reflect.get(result, "username") !== "string"
        || typeof Reflect.get(result, "password") !== "string" || typeof Reflect.get(result, "expiresAt") !== "number") {
        throw new Error("Git candidate credential is invalid");
      }
      return result as { username: string; password: string; expiresAt: number };
    },
    async publish(grant, result) {
      const { logs: _logs, ...evidence } = result;
      executionResultSchema.parse(await post(`/v1/executions/${grant.event.projectId}/${grant.event.repositoryId}/${grant.executionId}/evidence`, evidence, config.resultReporter));
    }
  };
}
export class StaleExecutionSourceError extends Error {}
