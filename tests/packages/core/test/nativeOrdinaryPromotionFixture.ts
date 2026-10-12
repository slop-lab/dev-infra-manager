import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { NativeGitResultReporterUnavailableError } from "../../../../core/packages/core/src/nativeGitResultReporter.js";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import {
  createNodeAdmissionVerifierHttpClient,
  createOrdinaryAdmissionVerifier
} from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { createApprovedReview } from "../../native-git/test/nativeGitPromotionHarness.js";
import {
  nativeGitReviewFixture,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";
import {
  activeEligibilityGeneration,
  authorityCredentials,
  jsonRecord,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const attemptPassword = "attempt-credential-secret-000000000000";
const reporterPassword = "reporter-credential-secret-00000000000";

type PromotionFixtureMode = "paused" | "lose-first-status-response";

export type NativeOrdinaryPromotionFixture = {
  readonly authority: AuthorityFixture;
  readonly native: ReviewFixture;
  readonly review: JsonObject;
  readonly events: ReturnType<typeof parseReviewEnvelope>["events"];
  readonly admissionGeneration: string;
  readonly lostStatusResponse: () => boolean;
  readonly rotateEligibility: () => Promise<string>;
  readonly rejectReporter: () => Promise<void>;
  readonly restoreReporter: () => Promise<void>;
};

export async function nativeOrdinaryPromotionFixture(
  mode: PromotionFixtureMode
): Promise<NativeOrdinaryPromotionFixture> {
  let authorityEndpoint = "";
  let nativeEndpoint = "";
  let lostStatusResponse = false;
  const nativeTransport = createNodeNativeGitAdmissionHttpClient();
  const nativeHttpClient = {
    async request(input: Parameters<typeof nativeTransport.request>[0]) {
      const response = await nativeTransport.request({ ...input, endpoint: nativeEndpoint });
      if (mode === "lose-first-status-response" && input.path.endsWith("/statuses") && !lostStatusResponse) {
        lostStatusResponse = true;
        throw new Error("simulated response loss after native status commit");
      }
      return response;
    }
  };
  const authority = await startAuthority({
    nativeGitHttpClient: nativeHttpClient,
    useStandaloneAttemptIssuer: true,
    nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
    nativeGitResultReporter: { username: "ordinary-results", password: reporterPassword },
    ...(mode === "paused"
      ? {
          resultReporterClient: {
            async send() {
              throw new NativeGitResultReporterUnavailableError();
            }
          }
        }
      : { useConfiguredResultReporter: true })
  });
  authorityEndpoint = authority.endpoint;
  const verifierTransport = createNodeAdmissionVerifierHttpClient();
  const verifier = await createOrdinaryAdmissionVerifier({
    config: {
      endpoint: "http://ordinary-ci:8080",
      serviceId: "ordinary-main",
      query: authorityCredentials.query,
      identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
      attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
      resultReporter: { username: "ordinary-results", password: reporterPassword },
      webhook: {
        endpoint: "http://ordinary-ci:8080/v1/native-events",
        username: authorityCredentials.webhook.username,
        password: authorityCredentials.webhook.password
      }
    },
    httpClient: {
      request: (input) => verifierTransport.request({ ...input, endpoint: authorityEndpoint })
    }
  });
  const native = await nativeGitReviewFixture(verifier);
  await configureNative(native, reporterPassword);
  nativeEndpoint = native.baseUrl();
  const review = await createApprovedReview(native);
  const reviewId = stringField(review, "reviewId");
  const envelope = parseReviewEnvelope(JSON.parse(await readFile(
    join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`), "utf8"
  )));
  const policy = {
    schemaVersion: 1,
    projectId: "project-a",
    repositoryId: "source",
    protectedRef: "refs/heads/main",
    policyRevision: "policy-1",
    requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1",
    requiredJobs: ["security", "source"]
  } as const;
  const initialEvent = envelope.events[0];
  if (initialEvent === undefined) throw new Error("ordinary review event is missing");
  const intake = await post(authority.endpoint, "/v1/native-events", "webhook", initialEvent);
  if (intake.status !== 202) throw new Error(await intake.text());
  const admissionGeneration = activeEligibilityGeneration(authority, policy.projectId, policy.repositoryId);
  return {
    authority,
    native,
    review,
    events: envelope.events,
    admissionGeneration,
    lostStatusResponse: () => lostStatusResponse,
    async rotateEligibility() {
      const nextConfig = native.configWithPolicyRevision("policy-2");
      const ordinaryCi = nextConfig.ordinaryCi;
      if (ordinaryCi === undefined) throw new Error("ordinary CI config is missing");
      await native.restart({
        ...nextConfig,
        ordinaryCi: {
          ...ordinaryCi,
          attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
          resultReporter: { username: "ordinary-results", password: reporterPassword }
        }
      });
      nativeEndpoint = native.baseUrl();
      const rotatedReview = await createApprovedReview(native);
      const rotatedReviewId = stringField(rotatedReview, "reviewId");
      const rotatedEnvelope = parseReviewEnvelope(JSON.parse(await readFile(
        join(native.repositoryPath, "dim-reviews", "proposals", `${rotatedReviewId}.json`), "utf8"
      )));
      const rotatedEvent = rotatedEnvelope.events[0];
      if (rotatedEvent === undefined) throw new Error("rotated ordinary review event is missing");
      const response = await post(authority.endpoint, "/v1/native-events", "webhook", rotatedEvent);
      if (response.status !== 202) throw new Error(await response.text());
      return activeEligibilityGeneration(authority, policy.projectId, policy.repositoryId);
    },
    async rejectReporter() {
      await configureNative(native, "replacement-reporter-secret-000000000");
      nativeEndpoint = native.baseUrl();
    },
    async restoreReporter() {
      await configureNative(native, reporterPassword);
      nativeEndpoint = native.baseUrl();
    }
  };
}

async function configureNative(native: ReviewFixture, resultReporterPassword: string): Promise<void> {
  const ordinaryCi = native.config.ordinaryCi;
  if (ordinaryCi === undefined) throw new Error("ordinary CI config is missing");
  await native.restart({
    ...native.config,
    ordinaryCi: {
      ...ordinaryCi,
      attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
      resultReporter: { username: "ordinary-results", password: resultReporterPassword }
    }
  });
}
