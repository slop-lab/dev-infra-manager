import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { deriveAuthoritativeQemuExecutionDescriptor } from "./authoritative-qemu-execution-descriptor.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { ordinaryExecutionDescriptorRequestFields } from "./candidate-execution-schema.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { NativeQemuAuthorityState } from "./native-qemu-authority-state.js";

const identifier = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const route = new RegExp(`^/v1/projects/(${identifier})/repositories/root/(?:reviews/([0-9a-f]{64})/(qemu-execution-descriptors|qemu-attempts|qemu-attempt-revocations|qemu-statuses)|native-qemu-proof/(policy|review-event))$`);
const descriptorRequest = z.object({ schemaVersion: z.literal(1), jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  trustedCapacity: z.object({ admissionGeneration: ordinaryExecutionDescriptorRequestFields.admissionGeneration,
    jobBaseImage: ordinaryExecutionDescriptorRequestFields.jobBaseImage,
    runnerBaseImage: ordinaryExecutionDescriptorRequestFields.runnerBaseImage,
    bounds: ordinaryExecutionDescriptorRequestFields.bounds }).strict().readonly() }).strict().readonly();
const issueRequest = z.object({ schemaVersion: z.literal(1), descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  claim: z.object({ claimId: z.string().uuid(), issuanceRequestId: z.string().uuid(),
    hostId: z.string(), capacity: z.string(), admissionGeneration: z.string(),
    event: z.object({ projectId: z.string(), reviewId: z.string(), jobName: z.string(),
      executionKind: z.literal("qemu") }).passthrough(), runnerBaseImage: z.string(), jobBaseImage: z.string(),
    bounds: ordinaryExecutionDescriptorRequestFields.bounds }).passthrough() }).strict().readonly();
const proofRequest = z.object({ schemaVersion: z.literal(1), requestId: z.string().uuid(), eventId: z.string().optional(),
  reviewId: z.string().optional(), executionKind: z.literal("qemu").optional(), jobName: z.string().optional() }).strict().readonly();

type Credential = { readonly username: string; readonly password: string };
type Input = { readonly config: NativeGitBundleConfig; readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result> };
export type NativeQemuAuthorityService = { readonly handle: (request: IncomingMessage,
  response: ServerResponse, url: URL) => Promise<boolean> };

export function createNativeQemuAuthorityService(input: Input): NativeQemuAuthorityService | undefined {
  const qemu = input.config.qemuCi;
  if (qemu === undefined) return undefined;
  return { async handle(request, response, url) {
    if (request.method !== "POST" || url.search !== "") return false;
    const match = route.exec(url.pathname);
    const projectId = match?.[1];
    const reviewId = match?.[2];
    const action = match?.[3] ?? match?.[4];
    if (projectId === undefined || action === undefined) return false;
    const credential = action === "policy" || action === "review-event" ? qemu.identity
      : action === "qemu-statuses" ? qemu.resultReporter : qemu.attemptIssuer;
    if (!authorize(request, credential, input.knownCredentials, response)) return true;
    try {
      const body = await readBody(request);
      if (action === "policy") {
        proofRequest.parse(body);
        const target = await input.serialize(() => resolveAuthoritativeNativeRootTarget(input.runtime, { projectId }));
        send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId, projectId,
          policy: target.imported.policy, currentRoot: target.currentHead });
        return true;
      }
      if (action === "review-event") {
        const selector = proofRequest.parse(body);
        if (selector.eventId === undefined || selector.reviewId === undefined || selector.jobName === undefined) invalid();
        const eventId = selector.eventId;
        const selectedReviewId = selector.reviewId;
        const jobName = selector.jobName;
        const proof = await input.serialize(async () => {
          const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
          const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selectedReviewId);
          const event = envelope?.events.find((candidate) => candidate.eventId === eventId
            && candidate.executionKind === "qemu" && candidate.jobName === jobName);
          if (envelope === undefined || event === undefined
            || (await nativeHumanReviewStaleReasons(input.runtime, target, envelope.review)).length > 0) invalid();
          return event;
        });
        send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId, event: proof });
        return true;
      }
      if (reviewId === undefined) return false;
      if (action === "qemu-execution-descriptors") {
        const requestBody = descriptorRequest.parse(body);
        const execution = await input.serialize(() => deriveAuthoritativeQemuExecutionDescriptor(input.runtime,
          { projectId, reviewId, jobName: requestBody.jobName, trustedCapacity: requestBody.trustedCapacity }));
        send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId, ...execution });
        return true;
      }
      if (action === "qemu-attempts") {
        const requestBody = issueRequest.parse(body);
        const claim = requestBody.claim;
        if (claim.claimId !== claim.issuanceRequestId || claim.event.projectId !== projectId
          || claim.event.reviewId !== reviewId) invalid();
        const result = await input.serialize(async () => {
          const execution = await deriveAuthoritativeQemuExecutionDescriptor(input.runtime, { projectId, reviewId,
            jobName: claim.event.jobName, trustedCapacity: { admissionGeneration: claim.admissionGeneration,
              jobBaseImage: claim.jobBaseImage, runnerBaseImage: claim.runnerBaseImage, bounds: claim.bounds } });
          if (execution.digest !== requestBody.descriptorDigest) invalid();
          const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
          const attempt = await new NativeQemuAuthorityState(target.repository).issue({
            issuanceRequestId: claim.issuanceRequestId, reviewId, descriptor: execution.descriptor,
            descriptorDigest: execution.digest, hostId: claim.hostId, capacity: claim.capacity });
          return { attempt };
        });
        send(response, 201, { schemaVersion: 1, serviceId: input.config.serviceId, ...result });
        return true;
      }
      if (action === "qemu-attempt-revocations") {
        const value = record(body);
        if (typeof value.jobName !== "string" || typeof value.attemptId !== "string") invalid();
        const jobName = value.jobName;
        const attemptId = value.attemptId;
        const revoked = await input.serialize(async () => {
          const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
          return new NativeQemuAuthorityState(target.repository).revoke(reviewId, jobName, attemptId);
        });
        send(response, 201, { schemaVersion: 1, serviceId: input.config.serviceId, revocation: revoked });
        return true;
      }
      const event = record(body);
      const payload = record(event.payload);
      if (payload.executionKind !== "qemu" || payload.evidenceClass !== "candidate-controlled"
        || payload.reviewId !== reviewId || typeof payload.attemptId !== "string"
        || typeof payload.descriptorDigest !== "string" || typeof payload.result !== "string"
        || typeof event.eventId !== "string") invalid();
      const statusEventId = event.eventId;
      const attemptId = payload.attemptId;
      const descriptorDigest = payload.descriptorDigest;
      const resultValue = payload.result;
      const status = await input.serialize(async () => {
        const target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
        const state = new NativeQemuAuthorityState(target.repository);
        const current = await state.current(reviewId, String(record(payload.descriptor).jobName));
        if (current === undefined || current.attemptId !== attemptId
          || !isDeepStrictEqual(current.descriptor, payload.descriptor)) invalid();
        return state.status({ schemaVersion: 1, executionKind: "qemu", eventId: statusEventId,
          attemptId, descriptorDigest, result: result(resultValue), event });
      });
      send(response, 201, status);
    } catch {
      send(response, 409, { error: "native QEMU authority tuple conflicts" });
    }
    return true;
  } };
}

function result(value: string): "success" | "failure" | "cancelled" {
  if (value !== "success" && value !== "failure" && value !== "cancelled") invalid(); return value;
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") invalid();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length; if (size > 256 * 1024) invalid(); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function authorize(request: IncomingMessage, credential: Credential, known: readonly Credential[], response: ServerResponse): boolean {
  if (basic(request, credential)) return true; send(response, known.some((entry) => basic(request, entry)) ? 403 : 401,
    { error: known.some((entry) => basic(request, entry)) ? "forbidden" : "unauthorized" }); return false;
}
function basic(request: IncomingMessage, credential: Credential): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function send(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); response.end(`${JSON.stringify(body)}\n`);
}
function invalid(): never { throw new NativeQemuAuthorityHttpError(); }
class NativeQemuAuthorityHttpError extends Error { readonly name = "NativeQemuAuthorityHttpError"; }
