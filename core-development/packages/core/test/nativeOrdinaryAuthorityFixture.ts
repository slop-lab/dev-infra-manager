import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  configuredNativeOrdinaryAuthorityServer,
  NativeAdmissionSourceRejectedError,
  type NativeAdmissionSource,
  type NativeOrdinaryAuthorityConfig
} from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import type {
  NativeAdmissionPolicy,
  NativeAttemptAssignment
} from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import { createNodeAdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { createOrdinaryAdmissionVerifier } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { descriptorDigest } from "../../../../core/packages/native-git/src/candidate-execution.js";
import type { CandidateOrdinaryExecutionDescriptor } from "../../../../core/packages/native-git/src/candidate-execution-schema.js";

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;

export const authorityCredentials = {
  registrar: { username: "operator-registrar", password: "registrar-secret-00000000000000000000" },
  query: { username: "native-query", password: "query-secret-0000000000000000000000" },
  scheduler: { username: "ordinary-scheduler", password: "scheduler-secret-0000000000000000" }
} as const;

export type AuthorityFixture = {
  readonly database: string;
  readonly endpoint: string;
  readonly source: NativeAdmissionProofFixture;
  readonly close: () => Promise<void>;
  readonly remove: () => Promise<void>;
};

export type StartAuthorityOptions = {
  readonly database?: string;
  readonly now?: () => number;
  readonly source?: NativeAdmissionProofFixture;
  readonly useDefaultSource?: boolean;
};

export async function startAuthority(options: StartAuthorityOptions = {}): Promise<AuthorityFixture> {
  const root = options.database === undefined ? await mkdtemp(join(tmpdir(), "dim-native-authority-")) : undefined;
  const database = options.database ?? join(root ?? "", "ordinary.sqlite3");
  const source = options.source ?? new NativeAdmissionProofFixture();
  const config = {
    schemaVersion: 3,
    serviceId: "ordinary-main",
    database,
    admissionLeaseMilliseconds: 300_000,
    credentials: authorityCredentials,
    hosts: [{ hostId: "host-a", capacities: [{ capacity: "primary", runnerBaseImage, bounds }] }]
  } satisfies NativeOrdinaryAuthorityConfig;
  const dependencies = { clock: { now: options.now ?? Date.now } };
  const server = options.useDefaultSource === true
    ? configuredNativeOrdinaryAuthorityServer(config, dependencies)
    : configuredNativeOrdinaryAuthorityServer(config, { ...dependencies, admissionSource: source });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    database,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    source,
    close: () => closeServer(server),
    remove: () => root === undefined ? Promise.resolve() : rm(root, { recursive: true, force: true })
  };
}

export class NativeAdmissionProofFixture implements NativeAdmissionSource {
  readonly #policies = new Map<string, { readonly requested: NativeAdmissionPolicy; readonly canonical: NativeAdmissionPolicy }>();
  readonly #attempts = new Map<string, { readonly requested: NativeAttemptAssignment; readonly canonical: NativeAttemptAssignment }>();

  authorizePolicy(requested: NativeAdmissionPolicy, canonical: NativeAdmissionPolicy = requested): void {
    this.#policies.set(`${requested.projectId}\0${requested.repositoryId}`, { requested, canonical });
  }

  authorizeAttempt(requested: NativeAttemptAssignment, canonical: NativeAttemptAssignment = requested): void {
    this.#attempts.set(requested.attemptId, { requested, canonical });
  }

  async assertRegisteredPolicy(input: NativeAdmissionPolicy): Promise<NativeAdmissionPolicy> {
    const proof = this.#policies.get(`${input.projectId}\0${input.repositoryId}`);
    if (proof === undefined || !isDeepStrictEqual(proof.requested, input)) throw new NativeAdmissionSourceRejectedError();
    return proof.canonical;
  }

  async assertIssuedAttempt(input: NativeAttemptAssignment): Promise<NativeAttemptAssignment> {
    const proof = this.#attempts.get(input.attemptId);
    if (proof === undefined || !isDeepStrictEqual(proof.requested, input)) throw new NativeAdmissionSourceRejectedError();
    return proof.canonical;
  }
}

export async function verifier(endpoint: string) {
  return createOrdinaryAdmissionVerifier({
    config: {
      endpoint: "http://ordinary-ci:8080",
      serviceId: "ordinary-main",
      query: authorityCredentials.query,
      identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
      attemptIssuer: { username: "ordinary-attempts", password: "attempt-secret-000000000000000000000" },
      resultReporter: { username: "ordinary-results", password: "result-secret-0000000000000000000000" }
    },
    httpClient: createNodeAdmissionVerifierHttpClient(endpoint)
  });
}

export function admission(projectId: string, repositoryId: string, revision: string) {
  return {
    schemaVersion: 1,
    projectId,
    repositoryId,
    protectedRef: "refs/heads/main",
    policyRevision: `policy-${revision}`,
    requiredReviewRevision: `review-${revision}`,
    requiredJobSetRevision: `jobs-${revision}`,
    requiredJobs: ["source"],
    eligibleAssignments: [{ hostId: "host-a", capacity: "primary" }]
  } as const;
}

export function descriptor(projectId: string, repositoryId: string, generation: string): CandidateOrdinaryExecutionDescriptor {
  return {
    projectId,
    repositoryId,
    protectedRef: "refs/heads/main",
    expectedProtectedHead: "1".repeat(40),
    candidateCommit: "2".repeat(40),
    candidateTree: "3".repeat(40),
    policyRevision: "policy-1",
    requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1",
    admissionGeneration: generation,
    jobName: "source",
    runnerBaseImage,
    bounds,
    evidenceClass: "candidate-controlled",
    configBlob: { objectId: "4".repeat(40), sha256: `sha256:${"5".repeat(64)}` },
    script: { objectId: "6".repeat(40), sha256: `sha256:${"7".repeat(64)}`, path: ".dim/ci/jobs/source.bash" },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
    jobImage: `registry.example/source@sha256:${"8".repeat(64)}`
  };
}

export function assignment(descriptorValue: CandidateOrdinaryExecutionDescriptor, reviewId: string, attemptId: string) {
  return {
    schemaVersion: 1,
    reviewId,
    attemptId,
    descriptor: descriptorValue,
    descriptorDigest: descriptorDigest(descriptorValue),
    admissionGeneration: descriptorValue.admissionGeneration,
    hostId: "host-a",
    capacity: "primary"
  } as const;
}

export function post(endpoint: string, path: string, role: keyof typeof authorityCredentials, body: object): Promise<Response> {
  const credential = authorityCredentials[role];
  return fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function jsonRecord(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected JSON object");
  return value as Readonly<Record<string, unknown>>;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}
