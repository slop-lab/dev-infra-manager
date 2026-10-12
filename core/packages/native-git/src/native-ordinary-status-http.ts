import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createAuthoritativeOrdinaryAttemptStore } from "./authoritative-ordinary-attempt-store.js";
import {
  authoritativeOrdinaryTerminalEventSchema,
  type AuthoritativeOrdinaryTerminalEvent
} from "./authoritative-ordinary-status-schema.js";
import {
  AuthoritativeOrdinaryStatusStoreError,
  readExistingAuthoritativeOrdinaryStatus,
  saveAuthoritativeOrdinaryStatus
} from "./authoritative-ordinary-status-store.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import {
  OrdinaryCurrentResultProofConflictError,
  OrdinaryCurrentResultProofUnavailableError,
  verifyOrdinaryCurrentResult
} from "./ordinary-current-result-proof.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";

const maximumBodyBytes = 256 * 1024;
const identifier = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const routePattern = new RegExp(
  `^/v1/projects/(${identifier})/repositories/root/reviews/([0-9a-f]{64})/statuses$`
);
type Credential = { readonly username: string; readonly password: string };
type StatusServiceInput = {
  readonly config: NativeGitBundleConfig;
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};
type CurrentTuple = {
  readonly target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
  readonly envelope: NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>>;
  readonly attempt: NonNullable<Awaited<ReturnType<ReturnType<typeof createAuthoritativeOrdinaryAttemptStore>["current"]>>>;
};

export type NativeOrdinaryStatusService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeOrdinaryStatusService(input: StatusServiceInput): NativeOrdinaryStatusService {
  return {
    async handle(request, response, url) {
      const route = statusRoute(request, url);
      if (route === undefined) return false;
      if (!authorize(request, input.config.ordinaryCi.resultReporter, input.knownCredentials, response)) return true;
      if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
        send(response, 409, { error: "ordinary terminal status generation conflicts with service startup" });
        return true;
      }
      if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state,
        input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) {
        send(response, 503, { error: "ordinary terminal status authority is unavailable" });
        return true;
      }
      let event: AuthoritativeOrdinaryTerminalEvent;
      try {
        event = authoritativeOrdinaryTerminalEventSchema.parse(await readBody(request));
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof NativeOrdinaryStatusBodyError || error instanceof SyntaxError) {
          send(response, 400, { error: "ordinary terminal status is invalid" });
          return true;
        }
        throw error;
      }
      if (event.payload.reviewId !== route.reviewId || event.payload.descriptor.projectId !== route.projectId
        || event.payload.descriptor.repositoryId !== "root") {
        send(response, 404, { error: "not found" });
        return true;
      }
      try {
        const status = await input.serialize(async () => {
          const before = await currentTuple(input.runtime, route.projectId, route.reviewId, event);
          const existing = await readExistingAuthoritativeOrdinaryStatus(before.target.repository, event,
            input.config.ordinaryCi.resultReporter.username);
          if (existing !== undefined) return existing;
          await verifyOrdinaryCurrentResult({
            config: input.config.ordinaryCi,
            generationId: input.runtime.expectedGenerationId,
            httpClient: input.httpClient,
            projectId: route.projectId,
            root: { sequence: before.target.currentHead.sequence, commit: before.target.currentHead.commit,
              tree: before.target.currentHead.tree },
            event
          });
          const after = await currentTuple(input.runtime, route.projectId, route.reviewId, event);
          if (!isDeepStrictEqual(after, before)) throw new NativeOrdinaryStatusConflictError();
          return saveAuthoritativeOrdinaryStatus(before.target.repository, event,
            input.config.ordinaryCi.resultReporter.username);
        });
        send(response, 201, status.status);
      } catch (error) {
        if (error instanceof NativeOrdinaryStatusConflictError || error instanceof OrdinaryCurrentResultProofConflictError
          || error instanceof AuthoritativeOrdinaryStatusStoreError || error instanceof CandidateExecutionError) {
          send(response, 409, { error: "ordinary terminal status conflicts with current authority" });
        } else if (error instanceof OrdinaryCurrentResultProofUnavailableError || error instanceof Error) {
          send(response, 503, { error: "ordinary terminal status authority is unavailable" });
        } else {
          throw error;
        }
      }
      return true;
    }
  };
}

async function currentTuple(runtime: AuthoritativeNativeCandidateRuntime, projectId: string, reviewId: string,
  event: AuthoritativeOrdinaryTerminalEvent): Promise<CurrentTuple> {
  const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== "root") {
    throw new NativeOrdinaryStatusConflictError();
  }
  const review = envelope.review;
  const descriptor = event.payload.descriptor;
  const required = envelope.planning.status === "valid" && envelope.planning.jobs.some((job) => job.executionKind === "ordinary-sysbox"
    && job.jobName === descriptor.jobName);
  if (!required || envelope.qualityRevision !== target.imported.policy.requiredJobSetRevision
    || (await nativeHumanReviewStaleReasons(runtime, target, review)).length > 0
    || review.protectedRef !== descriptor.protectedRef || review.expectedProtectedHead !== descriptor.expectedProtectedHead
    || review.candidateCommit !== descriptor.candidateCommit || review.candidateTree !== descriptor.candidateTree
    || review.policyRevision !== descriptor.policyRevision || review.requiredReviewRevision !== descriptor.requiredReviewRevision
    || envelope.qualityRevision !== descriptor.requiredJobSetRevision) {
    throw new NativeOrdinaryStatusConflictError();
  }
  const attempt = await createAuthoritativeOrdinaryAttemptStore(target.repository).current(reviewId, descriptor.jobName);
  if (attempt === undefined || attempt.revocation !== undefined || attempt.attempt.attemptId !== event.payload.attemptId
    || attempt.attempt.attempt !== event.payload.attempt || attempt.attempt.descriptorDigest !== event.payload.descriptorDigest
    || attempt.attempt.hostId !== event.payload.hostId || attempt.attempt.capacity !== event.payload.capacity
    || !isDeepStrictEqual(attempt.attempt.descriptor, descriptor)) {
    throw new NativeOrdinaryStatusConflictError();
  }
  return { target, envelope, attempt };
}

function statusRoute(request: IncomingMessage, url: URL): { readonly projectId: string; readonly reviewId: string } | undefined {
  if (request.method !== "POST" || url.search !== "") return undefined;
  const match = routePattern.exec(url.pathname);
  const projectId = match?.[1];
  const reviewId = match?.[2];
  return projectId === undefined || reviewId === undefined ? undefined : { projectId, reviewId };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new NativeOrdinaryStatusBodyError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new NativeOrdinaryStatusBodyError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorize(request: IncomingMessage, credential: Credential, known: readonly Credential[], response: ServerResponse): boolean {
  if (basicAuthorized(request, credential)) return true;
  const recognized = known.some((candidate) => basicAuthorized(request, candidate));
  send(response, recognized ? 403 : 401, { error: recognized ? "forbidden" : "unauthorized" });
  return false;
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

class NativeOrdinaryStatusBodyError extends Error { readonly name = "NativeOrdinaryStatusBodyError"; }
class NativeOrdinaryStatusConflictError extends Error { readonly name = "NativeOrdinaryStatusConflictError"; }
