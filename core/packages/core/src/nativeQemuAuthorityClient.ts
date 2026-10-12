import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import type { NativeQemuCapacity, NativeQemuCredential, NativeQemuSchedulerConfig } from "./nativeQemuSchedulerConfig.js";
import type { NativeQemuClaim, NativeQemuReviewEvent } from "./nativeQemuSchedulerStore.js";

export type NativeQemuPolicyProof = { readonly projectId: string; readonly policyRevision: string;
  readonly requiredJobSetRevision: string; readonly requiredQemuJobs: readonly string[] };
export type NativeQemuAttempt = { readonly attemptId: string; readonly descriptorDigest: string;
  readonly descriptor: Readonly<Record<string, unknown>> };
export type NativeQemuTerminalEvent = Readonly<Record<string, unknown>>;
export interface NativeQemuAuthorityClient {
  readPolicy(projectId: string, signal: AbortSignal): Promise<NativeQemuPolicyProof>;
  proveEvent(event: NativeQemuReviewEvent, signal: AbortSignal): Promise<void>;
  issue(claim: NativeQemuClaim, capacity: NativeQemuCapacity, signal: AbortSignal): Promise<NativeQemuAttempt>;
  revoke(claim: NativeQemuClaim, attemptId: string, signal: AbortSignal): Promise<void>;
  report(claim: NativeQemuClaim, event: NativeQemuTerminalEvent, signal: AbortSignal): Promise<void>;
  candidateLease(claim: NativeQemuClaim, attemptId: string, descriptorDigest: string,
    signal: AbortSignal): Promise<import("./nativeCandidateLease.js").NativeCandidateLease>;
}

export function createNativeQemuAuthorityClient(config: NativeQemuSchedulerConfig): NativeQemuAuthorityClient {
  return {
    async readPolicy(projectId, signal) {
      const requestId = randomUUID();
      const response = await send(config.nativeGit.endpoint, config.nativeGit.identity,
        `/v1/projects/${encodeURIComponent(projectId)}/repositories/root/native-qemu-proof/policy`,
        { schemaVersion: 1, requestId }, signal);
      const root = record(response);
      const policy = record(root.policy);
      if (root.projectId !== projectId || typeof policy.policyRevision !== "string"
        || typeof policy.requiredJobSetRevision !== "string" || !Array.isArray(policy.requiredJobs)) invalid();
      const requiredQemuJobs = policy.requiredJobs.flatMap((value): string[] => {
        const job = record(value);
        return job.kind === "qemu" && typeof job.name === "string" ? [job.name] : [];
      });
      if (requiredQemuJobs.length === 0) invalid();
      return { projectId, policyRevision: policy.policyRevision,
        requiredJobSetRevision: policy.requiredJobSetRevision, requiredQemuJobs };
    },
    async proveEvent(event, signal) {
      const response = record(await send(config.nativeGit.endpoint, config.nativeGit.identity,
        `/v1/projects/${encodeURIComponent(event.projectId)}/repositories/root/native-qemu-proof/review-event`,
        { schemaVersion: 1, requestId: randomUUID(), eventId: event.eventId,
          reviewId: event.reviewId, executionKind: "qemu", jobName: event.jobName }, signal));
      if (record(response.event).eventId !== event.eventId) invalid();
    },
    async issue(claim, capacity, signal) {
      const prefix = `/v1/projects/${encodeURIComponent(claim.event.projectId)}/repositories/root/reviews/${claim.event.reviewId}`;
      const descriptorResponse = record(await send(config.nativeGit.endpoint, config.nativeGit.attemptIssuer,
        `${prefix}/qemu-execution-descriptors`, { schemaVersion: 1, jobName: claim.event.jobName,
          trustedCapacity: { admissionGeneration: claim.admissionGeneration,
            jobBaseImage: capacity.jobBaseImage, runnerBaseImage: capacity.runnerBaseImage,
            bounds: capacity.bounds } }, signal));
      if (typeof descriptorResponse.digest !== "string") invalid();
      const issued = record(await send(config.nativeGit.endpoint, config.nativeGit.attemptIssuer,
        `${prefix}/qemu-attempts`, { schemaVersion: 1, descriptorDigest: descriptorResponse.digest,
          claim: { ...claim, serviceId: "qemu-main", issuanceRequestId: claim.claimId,
            runnerBaseImage: capacity.runnerBaseImage, jobBaseImage: capacity.jobBaseImage,
            bounds: capacity.bounds } }, signal));
      const attempt = record(issued.attempt);
      if (typeof attempt.attemptId !== "string" || attempt.descriptorDigest !== descriptorResponse.digest) invalid();
      return { attemptId: attempt.attemptId, descriptorDigest: descriptorResponse.digest,
        descriptor: record(attempt.descriptor) };
    },
    async report(claim, event, signal) {
      const response = record(await send(config.nativeGit.endpoint, config.nativeGit.resultReporter,
        `/v1/projects/${encodeURIComponent(claim.event.projectId)}/repositories/root/reviews/${claim.event.reviewId}/qemu-statuses`,
        event, signal));
      if (response.attemptId !== record(event.payload).attemptId) invalid();
    },
    async revoke(claim, attemptId, signal) {
      const response = record(await send(config.nativeGit.endpoint, config.nativeGit.attemptIssuer,
        `/v1/projects/${encodeURIComponent(claim.event.projectId)}/repositories/root/reviews/${claim.event.reviewId}/qemu-attempt-revocations`,
        { schemaVersion: 1, revocationRequestId: attemptId, jobName: claim.event.jobName, attemptId }, signal));
      if (record(response.revocation).attemptId !== attemptId) invalid();
    },
    async candidateLease(claim, attemptId, descriptorDigest, signal) {
      const requestId = randomUUID();
      const response = record(await send(config.nativeGit.endpoint, config.nativeGit.candidateReader,
        "/v1/candidate-read-leases", { schemaVersion: 1, requestId, executionKind: "qemu",
          projectId: claim.event.projectId, reviewId: claim.event.reviewId, jobName: claim.event.jobName,
          attemptId, descriptorDigest, hostId: claim.hostId, capacity: claim.capacity }, signal));
      if (response.requestId !== requestId || response.serviceId !== "native-main"
        || typeof response.username !== "string" || typeof response.password !== "string"
        || typeof response.expiresAt !== "number") invalid();
      return { username: response.username, password: response.password, expiresAt: response.expiresAt };
    }
  };
}

async function send(endpoint: string, credential: NativeQemuCredential, path: string,
  body: unknown, signal: AbortSignal): Promise<unknown> {
  const serialized = JSON.stringify(body);
  const target = new URL(path, endpoint);
  return new Promise((resolve, reject) => {
    const sendRequest = target.protocol === "https:" ? secureRequest : request;
    const outgoing = sendRequest(target, { method: "POST", signal, headers: {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(serialized)
    } }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) incoming.destroy(new NativeQemuAuthorityError("native QEMU authority response is too large"));
        else chunks.push(chunk);
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        if (incoming.statusCode === undefined || incoming.statusCode < 200 || incoming.statusCode >= 300
          || incoming.headers["cache-control"] !== "no-store") {
          reject(new NativeQemuAuthorityError("native QEMU authority rejected the request")); return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(new NativeQemuAuthorityError("native QEMU authority response is invalid", { cause: error })); }
      });
    });
    outgoing.once("error", reject);
    outgoing.end(serialized);
  });
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function invalid(): never { throw new NativeQemuAuthorityError("native QEMU authority response is invalid"); }
export class NativeQemuAuthorityError extends Error { readonly name = "NativeQemuAuthorityError"; }
