import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  configuredNativeOrdinaryAuthorityServer,
  type NativeOrdinaryCredential,
  type NativeOrdinaryAuthorityConfig
} from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import type { NativeGitAttemptIssuerClient } from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import {
  NativeGitResultReporterUnavailableError,
  type NativeGitResultReporterClient
} from "../../../../core/packages/core/src/nativeGitResultReporter.js";
import { createNodeAdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { createOrdinaryAdmissionVerifier } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { descriptorDigest } from "../../../../core/packages/native-git/src/candidate-execution.js";
import type { CandidateOrdinaryExecutionDescriptor } from "../../../../core/packages/native-git/src/candidate-execution-schema.js";
import {
  nativeGitIdentityCredential,
  startNativeGitAdmissionFixture,
  type NativeGitAdmissionFixture
} from "./nativeGitAdmissionFixture.js";

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;

export const authorityCredentials = {
  webhook: { username: "native-events", password: "webhook-secret-000000000000000000000" },
  registrar: { username: "operator-registrar", password: "registrar-secret-00000000000000000000" },
  query: { username: "native-query", password: "query-secret-0000000000000000000000" }
} as const;

export const authorityHostCredentials = {
  "host-a": { username: "host-a", password: "host-a-token-000000000000000000000000" },
  "host-b": { username: "host-b", password: "host-b-token-000000000000000000000000" }
} as const;

export const nativeGitAttemptIssuerCredential = {
  username: "ordinary-attempts",
  password: "attempt-secret-000000000000000000000"
} as const;

export const nativeGitResultReporterCredential = {
  username: "ordinary-results",
  password: "result-secret-0000000000000000000000"
} as const;

export type AuthorityFixture = {
  readonly database: string;
  readonly endpoint: string;
  readonly source: NativeGitAdmissionFixture;
  readonly close: () => Promise<void>;
  readonly remove: () => Promise<void>;
};

export type StartAuthorityOptions = {
  readonly database?: string;
  readonly now?: () => number;
  readonly source?: NativeGitAdmissionFixture;
  readonly hosts?: NativeOrdinaryAuthorityConfig["hosts"];
  readonly nativeGitIdentity?: NativeOrdinaryCredential;
  readonly nativeGitAttemptIssuer?: NativeOrdinaryCredential;
  readonly nativeGitResultReporter?: NativeOrdinaryCredential;
  readonly nativeGitHttpClient?: NativeGitAdmissionHttpClient;
  readonly attemptIssuerClient?: NativeGitAttemptIssuerClient;
  readonly resultReporterClient?: NativeGitResultReporterClient;
  readonly useConfiguredResultReporter?: boolean;
};

export async function startAuthority(options: StartAuthorityOptions = {}): Promise<AuthorityFixture> {
  const root = options.database === undefined ? await mkdtemp(join(tmpdir(), "dim-native-authority-")) : undefined;
  const database = options.database ?? join(root ?? "", "ordinary.sqlite3");
  const source = options.source ?? await startNativeGitAdmissionFixture();
  const config = {
    schemaVersion: 3,
    serviceId: "ordinary-main",
    database,
    admissionLeaseMilliseconds: 300_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: options.nativeGitIdentity ?? nativeGitIdentityCredential,
      attemptIssuer: options.nativeGitAttemptIssuer ?? nativeGitAttemptIssuerCredential,
      resultReporter: options.nativeGitResultReporter ?? nativeGitResultReporterCredential
    },
    credentials: authorityCredentials,
    hosts: options.hosts ?? [
      { hostId: "host-a", hostToken: authorityHostCredentials["host-a"].password,
        capacities: [{ capacity: "primary", runnerBaseImage, bounds }] },
      { hostId: "host-b", hostToken: authorityHostCredentials["host-b"].password,
        capacities: [{ capacity: "backup", runnerBaseImage, bounds }] }
    ]
  } as const;
  const dependencies = {
    clock: { now: options.now ?? Date.now },
    nativeGitHttpClient: options.nativeGitHttpClient ?? source.httpClient,
    ...(options.attemptIssuerClient === undefined ? {} : { nativeGitAttemptIssuerClient: options.attemptIssuerClient }),
    ...(options.useConfiguredResultReporter === true
      ? {}
      : {
          nativeGitResultReporterClient: options.resultReporterClient ?? {
            async send() {
              throw new NativeGitResultReporterUnavailableError();
            }
          }
        })
  };
  const server = configuredNativeOrdinaryAuthorityServer(config, dependencies);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    database,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    source,
    close: async () => {
      await closeServer(server);
      await source.close();
    },
    remove: () => root === undefined ? Promise.resolve() : rm(root, { recursive: true, force: true })
  };
}

export async function verifier(endpoint: string) {
  return createOrdinaryAdmissionVerifier({
    config: {
      endpoint: "http://ordinary-ci:8080",
      serviceId: "ordinary-main",
      query: authorityCredentials.query,
      identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
      attemptIssuer: { username: "ordinary-attempts", password: "attempt-secret-000000000000000000000" },
      resultReporter: { username: "ordinary-results", password: "result-secret-0000000000000000000000" },
      webhook: {
        endpoint: "http://ordinary-ci:8080/v1/native-events",
        username: authorityCredentials.webhook.username,
        password: authorityCredentials.webhook.password
      }
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
    requiredJobs: ["source"]
  } as const;
}

export function nativeEvent(eventId = "00000000-0000-4000-8000-000000000001") {
  return {
    schemaVersion: 1,
    type: "dim.native.review-job.available",
    eventId,
    projectId: "project-a",
    repositoryId: "source",
    protectedRef: "refs/heads/main",
    reviewId: "a".repeat(64),
    expectedProtectedHead: "1".repeat(40),
    candidateCommit: "2".repeat(40),
    candidateTree: "3".repeat(40),
    policyRevision: "policy-1",
    requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1",
    jobName: "source",
    evidenceClass: "candidate-controlled"
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

export function post(
  endpoint: string,
  path: string,
  role: keyof typeof authorityCredentials | keyof typeof authorityHostCredentials,
  body: object
): Promise<Response> {
  const credential = role in authorityCredentials
    ? authorityCredentials[role as keyof typeof authorityCredentials]
    : authorityHostCredentials[role as keyof typeof authorityHostCredentials];
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
