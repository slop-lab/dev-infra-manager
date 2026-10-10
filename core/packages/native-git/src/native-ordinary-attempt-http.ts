import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deriveAuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";
import {
  AuthoritativeOrdinaryAttemptStoreError,
  createAuthoritativeOrdinaryAttemptStore
} from "./authoritative-ordinary-attempt-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import {
  CandidateExecutionError,
  ordinaryExecutionDescriptorRequestFields
} from "./candidate-execution-schema.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import {
  OrdinaryReservationClaimRejectedError,
  ordinaryReservationClaimSchema,
  type OrdinaryReservationClaim
} from "./ordinary-reservation-claim.js";

const maximumBodyBytes = 64 * 1024;
const identifier = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const routePattern = new RegExp(
  `^/v1/projects/(${identifier})/repositories/root/reviews/([0-9a-f]{64})/(ordinary-execution-descriptors|job-attempts|job-attempt-revocations)$`
);
const trustedCapacitySchema = z.object({
  admissionGeneration: ordinaryExecutionDescriptorRequestFields.admissionGeneration,
  jobBaseImage: ordinaryExecutionDescriptorRequestFields.jobBaseImage,
  runnerBaseImage: ordinaryExecutionDescriptorRequestFields.runnerBaseImage,
  bounds: ordinaryExecutionDescriptorRequestFields.bounds
}).strict().readonly();
const descriptorRequestSchema = z.object({
  schemaVersion: z.literal(1),
  jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  trustedCapacity: trustedCapacitySchema
}).strict().readonly();
const issueRequestSchema = z.object({
  schemaVersion: z.literal(1),
  descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  claim: ordinaryReservationClaimSchema
}).strict().readonly();
const revokeRequestSchema = z.object({
  schemaVersion: z.literal(1),
  revocationRequestId: z.string().uuid(),
  jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  attemptId: z.string().uuid()
}).strict().readonly().superRefine((request, context) => {
  if (request.revocationRequestId !== request.attemptId) {
    context.addIssue({ code: "custom", path: ["revocationRequestId"], message: "must equal attemptId" });
  }
});

type Credential = { readonly username: string; readonly password: string };
type AttemptRoute = {
  readonly kind: "descriptor" | "issue" | "revoke";
  readonly projectId: string;
  readonly reviewId: string;
};
type AttemptServiceInput = {
  readonly config: NativeGitBundleConfig;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly verifyClaim: (claim: OrdinaryReservationClaim) => Promise<void>;
  readonly hooks?: NativeOrdinaryAttemptHooks;
};

export type NativeOrdinaryAttemptHooks = {
  readonly beforeIssue?: () => void | Promise<void>;
};

export type NativeOrdinaryAttemptService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeOrdinaryAttemptService(input: AttemptServiceInput): NativeOrdinaryAttemptService {
  return {
    async handle(request, response, url) {
      if (request.method === "GET" && url.search === ""
        && url.pathname === "/v1/native-ordinary-attempt-authority/identity") {
        if (!authorize(request, input.config.ordinaryCi.attemptIssuer, input.knownCredentials, response)) return true;
        send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId,
          role: "native-ordinary-attempt-issuer",
          scope: ["ordinary-descriptor:derive", "ordinary-attempt:issue", "ordinary-attempt:revoke"],
          generationId: input.runtime.expectedGenerationId });
        return true;
      }
      const route = attemptRoute(request, url);
      if (route === undefined) return false;
      if (!authorize(request, input.config.ordinaryCi.attemptIssuer, input.knownCredentials, response)) return true;
      if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
        send(response, 409, { error: "attempt authority generation conflicts with service startup" });
        return true;
      }
      if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state,
        input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) {
        send(response, 503, { error: "ordinary attempt authority is unavailable" });
        return true;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof NativeOrdinaryAttemptBodyError) {
          send(response, 400, { error: "attempt authority request is invalid" });
          return true;
        }
        throw error;
      }
      const parsed = route.kind === "descriptor" ? descriptorRequestSchema.safeParse(body)
        : route.kind === "issue" ? issueRequestSchema.safeParse(body) : revokeRequestSchema.safeParse(body);
      if (!parsed.success) {
        send(response, 400, { error: "attempt authority request is invalid" });
        return true;
      }
      try {
        if (route.kind === "descriptor") {
          const requestBody = descriptorRequestSchema.parse(parsed.data);
          const execution = await input.serialize(() => deriveAuthoritativeOrdinaryExecutionDescriptor(input.runtime, {
            projectId: route.projectId, reviewId: route.reviewId,
            jobName: requestBody.jobName, trustedCapacity: requestBody.trustedCapacity
          }));
          send(response, 200, responseEnvelope(input, execution));
          return true;
        }
        if (route.kind === "issue") {
          const requestBody = issueRequestSchema.parse(parsed.data);
          const attempt = await input.serialize(async () => {
            await input.hooks?.beforeIssue?.();
            const claim = requestBody.claim;
            if (claim.event.projectId !== route.projectId || claim.event.reviewId !== route.reviewId) {
              throw new NativeOrdinaryAttemptConflictError("ordinary reservation claim selector changed");
            }
            const execution = await deriveAuthoritativeOrdinaryExecutionDescriptor(input.runtime, {
              projectId: route.projectId, reviewId: route.reviewId,
              jobName: claim.event.jobName,
              trustedCapacity: {
                admissionGeneration: claim.admissionGeneration,
                jobBaseImage: claim.jobBaseImage,
                runnerBaseImage: claim.runnerBaseImage,
                bounds: claim.bounds
              }
            });
            if (execution.digest !== requestBody.descriptorDigest) {
              throw new NativeOrdinaryAttemptConflictError("ordinary descriptor digest changed");
            }
            const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId: route.projectId });
            const store = createAuthoritativeOrdinaryAttemptStore(target.repository);
            const issueInput = {
              issuanceRequestId: claim.issuanceRequestId,
              execution,
              hostId: claim.hostId,
              capacity: claim.capacity,
              issuedBy: input.config.ordinaryCi.attemptIssuer.username
            } as const;
            try {
              await input.verifyClaim(claim);
            } catch (error) {
              if (!(error instanceof OrdinaryReservationClaimRejectedError) || error.statusCode !== 409) throw error;
              const replay = await store.replay(issueInput);
              if (replay !== undefined) return replay;
              throw error;
            }
            return store.issue(issueInput);
          });
          send(response, 201, { schemaVersion: 1, serviceId: input.config.serviceId,
            servingGenerationId: input.runtime.expectedGenerationId, attempt });
          return true;
        }
        const requestBody = revokeRequestSchema.parse(parsed.data);
        const revocation = await input.serialize(async () => {
          const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId: route.projectId });
          return createAuthoritativeOrdinaryAttemptStore(target.repository).revoke({
            revocationRequestId: requestBody.revocationRequestId,
            reviewId: route.reviewId,
            jobName: requestBody.jobName,
            attemptId: requestBody.attemptId,
            revokedBy: input.config.ordinaryCi.attemptIssuer.username
          });
        });
        send(response, 201, { schemaVersion: 1, serviceId: input.config.serviceId,
          servingGenerationId: input.runtime.expectedGenerationId, revocation });
      } catch (error) {
        if (error instanceof CandidateExecutionError || error instanceof AuthoritativeOrdinaryAttemptStoreError
          || error instanceof NativeOrdinaryAttemptConflictError || error instanceof OrdinaryReservationClaimRejectedError) {
          send(response, 409, { error: "ordinary attempt tuple conflicts with current authority" });
        } else if (error instanceof Error) {
          send(response, 503, { error: "ordinary attempt authority is unavailable" });
        } else {
          throw error;
        }
      }
      return true;
    }
  };
}

function responseEnvelope(input: AttemptServiceInput, execution: Awaited<ReturnType<
  typeof deriveAuthoritativeOrdinaryExecutionDescriptor
>>): Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, serviceId: input.config.serviceId,
    servingGenerationId: input.runtime.expectedGenerationId, ...execution };
}

function attemptRoute(request: IncomingMessage, url: URL): AttemptRoute | undefined {
  if (request.method !== "POST" || url.search !== "") return undefined;
  const match = routePattern.exec(url.pathname);
  const projectId = match?.[1];
  const reviewId = match?.[2];
  const action = match?.[3];
  if (projectId === undefined || reviewId === undefined) return undefined;
  if (action === "ordinary-execution-descriptors") return { kind: "descriptor", projectId, reviewId };
  if (action === "job-attempts") return { kind: "issue", projectId, reviewId };
  if (action === "job-attempt-revocations") return { kind: "revoke", projectId, reviewId };
  return undefined;
}

function authorize(
  request: IncomingMessage,
  credential: Credential,
  knownCredentials: readonly Credential[],
  response: ServerResponse
): boolean {
  if (basicAuthorized(request, credential)) return true;
  const known = knownCredentials.some((candidate) => basicAuthorized(request, candidate));
  send(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
  return false;
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(
    `${credential.username}:${credential.password}`, "utf8"
  ).toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new NativeOrdinaryAttemptBodyError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new NativeOrdinaryAttemptBodyError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = `${JSON.stringify(body)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumBodyBytes) {
    response.writeHead(500, { "Cache-Control": "no-store" }).end();
    return;
  }
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(serialized);
}

class NativeOrdinaryAttemptBodyError extends Error {
  readonly name = "NativeOrdinaryAttemptBodyError";
}

class NativeOrdinaryAttemptConflictError extends Error {
  readonly name = "NativeOrdinaryAttemptConflictError";
}
