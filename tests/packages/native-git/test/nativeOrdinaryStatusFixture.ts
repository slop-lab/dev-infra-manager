import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { bundleSecrets } from "./bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import {
  generationId,
  rootRepository,
  runGit,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

export const resultReporterAuthorization = `Basic ${Buffer.from(
  `ordinary-results:${bundleSecrets.resultReporter}`
).toString("base64")}`;
export const attemptIssuerAuthorization = `Basic ${Buffer.from(
  `ordinary-attempts:${bundleSecrets.attemptIssuer}`
).toString("base64")}`;
export const queryAuthorization = `Basic ${Buffer.from(
  `native-query:${bundleSecrets.nativeQuery}`
).toString("base64")}`;

const admissionGeneration = "00000000-0000-4000-8000-000000000054";
const outputDigest = `sha256:${createHash("sha256").update("").digest("hex")}`;
const trustedCapacity = {
  admissionGeneration,
  jobBaseImage: `registry.example/job@sha256:${"a".repeat(64)}`,
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  bounds: { cpu: "2", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "10485760" }
} as const;

export type StatusProofControl = {
  event?: Readonly<Record<string, unknown>>;
  mismatch?: boolean;
  beforeResponse?: () => void | Promise<void>;
  beforeTerminalResponse?: () => void | Promise<void>;
  terminalStatusCode?: number;
  terminalOverride?: Readonly<Record<string, unknown>>;
  readonly requestIds: string[];
};

export type OrdinaryStatusFixture = {
  readonly root: string;
  readonly service: RunningService;
  readonly review: Readonly<Record<string, unknown>>;
  readonly attempt: Readonly<Record<string, unknown>>;
  readonly claim: Readonly<Record<string, unknown>>;
  readonly event: Readonly<Record<string, unknown>>;
  readonly rootTree: string;
  readonly proof: StatusProofControl;
};

export async function ordinaryStatusFixture(
  label: string,
  proofHttpClient?: AdmissionVerifierHttpClient
): Promise<OrdinaryStatusFixture> {
  const proof: StatusProofControl = { requestIds: [] };
  let nativeRoot = "";
  let rootCommit = "";
  let rootTree = "";
  const httpClient: AdmissionVerifierHttpClient = {
    async request(input) {
      if (input.path === "/v1/claim-reservation-verifications" && input.body !== undefined) {
        const request = record(JSON.parse(input.body));
        const claim = record(request.claim);
        return jsonResponse({ schemaVersion: 1, serviceId: "ordinary-main", requestId: request.requestId,
          claimId: claim.claimId, issuanceRequestId: claim.issuanceRequestId, authorized: true });
      }
      if (/\/native-root-ci-result-proof\/current-result$/.test(input.path) && input.body !== undefined) {
        if (proofHttpClient !== undefined) return proofHttpClient.request(input);
        expectAuthorization(input.authorization, queryAuthorization);
        const request = record(JSON.parse(input.body));
        const requestId = stringField(request, "requestId");
        proof.requestIds.push(requestId);
        await proof.beforeResponse?.();
        const event = proof.mismatch === true ? { ...record(request.terminalEvent), eventId: randomUUID() } : request.terminalEvent;
        return jsonResponse({ schemaVersion: 1, serviceId: "ordinary-main", requestId,
          servingGenerationId: generationId, projectId: "project-a", repositoryId: "root",
          claimId: "00000000-0000-4000-8000-000000000061",
          serviceEpochId: "00000000-0000-4000-8000-000000000062", admissionGeneration,
          rootSequence: 0, rootCommit, rootTree, cleanupComplete: true, terminalEvent: event,
          terminalEventDigest: digest(JSON.stringify(event)) });
      }
      if (/\/native-root-ci-result-proof\/current-terminal$/.test(input.path) && input.body !== undefined) {
        expectAuthorization(input.authorization, queryAuthorization);
        const request = record(JSON.parse(input.body));
        const requestId = stringField(request, "requestId");
        proof.requestIds.push(requestId);
        await proof.beforeTerminalResponse?.();
        if (proof.terminalStatusCode !== undefined) {
          return { statusCode: proof.terminalStatusCode, contentType: "application/json", cacheControl: "no-store",
            body: Buffer.from(JSON.stringify({ error: "proof denied" })) };
        }
        const event = record(request.terminalEvent);
        const payload = record(event.payload);
        const descriptor = record(payload.descriptor);
        const acknowledgementJson = await readFile(statusRecordPath(nativeRoot, stringField(payload, "reviewId")), "utf8");
        return jsonResponse({ schemaVersion: 1, serviceId: "ordinary-main", requestId,
          servingGenerationId: generationId, projectId: "project-a", repositoryId: "root",
          claimId: "00000000-0000-4000-8000-000000000061", resultGenerationId: generationId,
          serviceEpochId: "00000000-0000-4000-8000-000000000062",
          admissionGeneration: descriptor.admissionGeneration, rootSequence: 0, rootCommit, rootTree,
          cleanupResourceId: "00000000-0000-4000-8000-000000000061", cleanupComplete: true,
          terminalEventDigest: digest(JSON.stringify(event)), statusAcknowledgementJson: acknowledgementJson,
          statusAcknowledgementDigest: digestBytes(acknowledgementJson), deliveredAt: 1_800_000_000_000,
          ...proof.terminalOverride });
      }
      throw new TypeError(`unexpected ordinary query request: ${input.path}`);
    }
  };
  const fixture = await nativeBundleReviewFixture(label, undefined, undefined, undefined, httpClient);
  nativeRoot = fixture.root;
  const envelope = await createBundleReview(fixture.service);
  rootCommit = envelope.review.expectedProtectedHead;
  rootTree = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", `${rootCommit}^{tree}`])).stdout.trim();
  const ordinaryEvent = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
  if (ordinaryEvent === undefined) throw new TypeError("ordinary review event is missing");
  const descriptorResponse = await post(fixture.service.origin, statusReviewPath(envelope.review.reviewId,
    "ordinary-execution-descriptors"), { schemaVersion: 1, jobName: "source", trustedCapacity }, attemptIssuerAuthorization);
  const descriptor = record(await descriptorResponse.json());
  const descriptorDigest = stringField(descriptor, "digest");
  const claim = claimFor(ordinaryEvent);
  const issueResponse = await post(fixture.service.origin, statusReviewPath(envelope.review.reviewId, "job-attempts"),
    { schemaVersion: 1, descriptorDigest, claim }, attemptIssuerAuthorization);
  const attempt = record(record(await issueResponse.json()).attempt);
  const now = new Date().toISOString();
  const event = {
    schemaVersion: 3,
    eventId: randomUUID(),
    occurredAt: now,
    eventType: "dim.ci.job.completed",
    payload: {
      executionKind: "ordinary-sysbox",
      reviewId: envelope.review.reviewId,
      attemptId: stringField(attempt, "attemptId"),
      attempt: numberField(attempt, "attempt"),
      descriptor: attempt.descriptor,
      descriptorDigest,
      hostId: "host-a",
      capacity: "primary",
      startedAt: now,
      finishedAt: now,
      result: "success",
      completion: { kind: "exited", exitCode: 0 },
      stdout: { bytes: "0", sha256: outputDigest, truncated: false },
      stderr: { bytes: "0", sha256: outputDigest, truncated: false }
    }
  } as const;
  proof.event = event;
  return { root: fixture.root, service: fixture.service, review: envelope.review, attempt, claim, event, rootTree, proof };
}

export function statusReviewPath(reviewId: unknown, action = "statuses"): string {
  if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
  return `/v1/projects/project-a/repositories/root/reviews/${reviewId}/${action}`;
}

export function statusRecordPath(root: string, reviewId: unknown, attempt = 1): string {
  if (typeof reviewId !== "string") throw new TypeError("review ID is missing");
  return join(rootRepository(root), "dim-authoritative-statuses", "ordinary-sysbox", reviewId, "source", `${attempt}.json`);
}

export function post(origin: string, path: string, body: object, authorization: string): Promise<Response> {
  return fetch(`${origin}${path}`, { method: "POST",
    headers: { authorization, "content-type": "application/json", "x-dim-generation-id": generationId },
    body: JSON.stringify(body) });
}

export async function readStatusRecord(root: string, reviewId: unknown): Promise<Readonly<Record<string, unknown>>> {
  return record(JSON.parse(await readFile(statusRecordPath(root, reviewId), "utf8")));
}

function claimFor(event: Readonly<Record<string, unknown>>) {
  const issuanceRequestId = randomUUID();
  return { schemaVersion: 1, serviceId: "ordinary-main", generationId,
    serviceEpochId: randomUUID(), requestId: randomUUID(), claimId: issuanceRequestId, issuanceRequestId,
    demandId: randomUUID(), admissionGeneration, eventDigest: `sha256:${"c".repeat(64)}`, event,
    admission: { projectId: "project-a", repositoryId: "root", importNonce: randomUUID(), rootSequence: 0,
      protectedRef: event.protectedRef, rootCommit: event.expectedProtectedHead, rootTree: event.candidateTree,
      policyDigest: "d".repeat(64), capacityConfigDigest: "e".repeat(64), leaseExpiresAt: 1_800_000_000_000 },
    hostId: "host-a", capacity: "primary", runnerBaseImage: trustedCapacity.runnerBaseImage,
    jobBaseImage: trustedCapacity.jobBaseImage, bounds: trustedCapacity.bounds } as const;
}

function jsonResponse(body: object) {
  return { statusCode: 200, contentType: "application/json", cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body)) } as const;
}
function expectAuthorization(actual: string, expected: string): void {
  if (actual !== expected) throw new TypeError("unexpected ordinary query credential");
}
function digest(value: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(JSON.parse(value)))).digest("hex")}`;
}
function digestBytes(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const selected = value[field];
  if (typeof selected !== "string") throw new TypeError(`expected ${field}`);
  return selected;
}
function numberField(value: Readonly<Record<string, unknown>>, field: string): number {
  const selected = value[field];
  if (typeof selected !== "number") throw new TypeError(`expected ${field}`);
  return selected;
}
