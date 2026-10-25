import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { executionGrantSchema, executionResultSchema } from "@slop-lab/dim-contracts-ci/execution";
import type { ExecutionAssignment, ExecutionGrant, ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";

type Credential = { readonly username: string; readonly password: string };
export const gitAdmissionTimeoutMilliseconds = 35_000;
type GitExecutionAuthorityPhase = "authorize" | "candidate-read" | "publish";
export type ExecutionSource = {
  authorize(assignment: ExecutionAssignment, signal?: AbortSignal): Promise<ExecutionGrant>;
  candidate(grant: ExecutionGrant, signal?: AbortSignal): Promise<{ username: string; password: string; expiresAt: number }>;
  publish(grant: ExecutionGrant, result: ExecutionResult, signal?: AbortSignal): Promise<void>;
};
export function nativeGitExecutionSource(config: {
  readonly endpoint: string; readonly grantIssuer: Credential; readonly candidateReader: Credential;
  readonly resultReporter: Credential;
}, generationId: string, client: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()): ExecutionSource {
  async function post(phase: GitExecutionAuthorityPhase, path: string, body: unknown, credential: Credential, signal?: AbortSignal): Promise<unknown> {
    let response: Awaited<ReturnType<NativeGitAdmissionHttpClient["request"]>>;
    try {
      response = await client.request({ endpoint: config.endpoint, path, method: "POST", generationId,
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
        body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(gitAdmissionTimeoutMilliseconds), ...(signal === undefined ? [] : [signal])]) });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new GitExecutionAuthorityError(phase, "timeout", { cause: error });
      }
      throw new GitExecutionAuthorityError(phase, "unavailable", { cause: error });
    }
    if (response.statusCode === 404 || response.statusCode === 409) throw new StaleExecutionSourceError();
    if (response.statusCode !== 201 || response.contentType !== "application/json" || response.cacheControl !== "no-store") {
      throw new GitExecutionAuthorityError(phase, "unavailable");
    }
    return JSON.parse(response.body.toString("utf8"));
  }
  return {
    async authorize(assignment, signal) {
      return executionGrantSchema.parse(await post("authorize", "/v1/execution-grants", { executionId: assignment.id,
        generationId, event: assignment.event, workerId: assignment.workerId, slotId: assignment.slotId,
        profile: assignment.profile }, config.grantIssuer, signal));
    },
    async candidate(grant, signal) {
      const result = await post("candidate-read", `/v1/executions/${grant.event.projectId}/${grant.event.repositoryId}/${grant.executionId}/read-lease`, {}, config.candidateReader, signal);
      if (result === null || typeof result !== "object" || typeof Reflect.get(result, "username") !== "string"
        || typeof Reflect.get(result, "password") !== "string" || typeof Reflect.get(result, "expiresAt") !== "number") {
        throw new Error("Git candidate credential is invalid");
      }
      return result as { username: string; password: string; expiresAt: number };
    },
    async publish(grant, result, signal) {
      const { logs: _logs, ...evidence } = result;
      executionResultSchema.parse(await post("publish", `/v1/executions/${grant.event.projectId}/${grant.event.repositoryId}/${grant.executionId}/evidence`, evidence, config.resultReporter, signal));
    }
  };
}
export class StaleExecutionSourceError extends Error {}
export class GitExecutionAuthorityError extends Error {
  readonly name = "GitExecutionAuthorityError";
  constructor(readonly phase: GitExecutionAuthorityPhase, readonly code: "timeout" | "unavailable", options?: ErrorOptions) {
    super(`Git execution authority ${phase} ${code}`, options);
  }
}
