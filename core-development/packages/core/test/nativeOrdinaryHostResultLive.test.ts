import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import {
  createNodeAdmissionVerifierHttpClient,
  createOrdinaryAdmissionVerifier
} from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";
import {
  authorityCredentials,
  jsonRecord,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const authorities: AuthorityFixture[] = [];
const natives: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
  await Promise.all(natives.splice(0).map((fixture) => fixture.close()));
});

describe("native ordinary result live integration", () => {
  it("retries the exact durable terminal event after native response loss and central restart", async () => {
    // Given
    const attemptPassword = "attempt-credential-secret-000000000000";
    const reporterPassword = "reporter-credential-secret-00000000000";
    let authorityEndpoint = "";
    let nativeEndpoint = "";
    let loseStatusResponse = true;
    const nativeTransport = createNodeNativeGitAdmissionHttpClient();
    const nativeHttpClient = {
      async request(input: Parameters<typeof nativeTransport.request>[0]) {
        const response = await nativeTransport.request({ ...input, endpoint: nativeEndpoint });
        if (input.path.endsWith("/statuses") && loseStatusResponse) {
          loseStatusResponse = false;
          throw new Error("simulated response loss after native status commit");
        }
        return response;
      }
    };
    const central = await startAuthority({
      nativeGitHttpClient: nativeHttpClient,
      nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
      nativeGitResultReporter: { username: "ordinary-results", password: reporterPassword },
      useConfiguredResultReporter: true
    });
    authorities.push(central);
    authorityEndpoint = central.endpoint;
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
    natives.push(native);
    const ordinaryCi = native.config.ordinaryCi;
    if (ordinaryCi === undefined) throw new Error("ordinary CI config is missing");
    await native.restart({
      ...native.config,
      ordinaryCi: {
        ...ordinaryCi,
        attemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
        resultReporter: { username: "ordinary-results", password: reporterPassword }
      }
    });
    nativeEndpoint = native.baseUrl();
    const reviewResponse = await native.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: native.proposalRef
    });
    const reviewId = stringField(await readJsonObject(reviewResponse), "reviewId");
    const proposal = parseReviewEnvelope(JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`), "utf8"
    )));
    const event = proposal.events.find((candidate) => candidate.jobName === "source");
    if (event === undefined) throw new Error("source event is missing");
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
    const admission = await post(central.endpoint, "/v1/operator-admissions", "registrar", policy);
    if (admission.status !== 200) throw new Error(await admission.text());
    const generation = (await jsonRecord(admission)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    expect((await post(central.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
    const claimed = await post(central.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000051",
      hostId: "host-a",
      capacity: "primary"
    });
    const claim = await jsonRecord(claimed);
    const terminal = terminalResult(claim);

    // When
    const accepted = await post(central.endpoint, "/v1/host-results", "host-a", terminal);
    await waitFor(() => !loseStatusResponse);
    await central.close();
    const restarted = await startAuthority({
      database: central.database,
      nativeGitHttpClient: nativeHttpClient,
      nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptPassword },
      nativeGitResultReporter: { username: "ordinary-results", password: reporterPassword },
      useConfiguredResultReporter: true
    });
    authorities.push(restarted);
    authorityEndpoint = restarted.endpoint;
    await waitFor(() => completed(restarted.database));
    const status = JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "statuses", reviewId, "source", "1.json"), "utf8"
    ));
    const next = await post(restarted.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000052",
      hostId: "host-a",
      capacity: "primary"
    });

    // Then
    expect(accepted.status).toBe(202);
    expect(status.payload).toEqual(terminal.terminalEvent.payload);
    expect(status.reporterUsername).toBe("ordinary-results");
    expect(next.status).toBe(204);
    expect((await native.git(native.repositoryPath, ["rev-parse", "refs/heads/main"])).stdout.trim())
      .toBe(native.protectedHead);
  });
});

function terminalResult(claim: Readonly<Record<string, unknown>>) {
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 1,
    requestId: "50000000-0000-4000-8000-000000000051",
    claimId: claim.claimId,
    terminalEvent: {
      schemaVersion: 2,
      eventId: "60000000-0000-4000-8000-000000000051",
      occurredAt: now,
      eventType: "dim.ci.job.completed",
      payload: {
        reviewId: claim.reviewId,
        attemptId: claim.attemptId,
        attempt: 1,
        descriptor: claim.descriptor,
        descriptorDigest: claim.descriptorDigest,
        hostId: claim.hostId,
        capacity: claim.capacity,
        startedAt: now,
        finishedAt: now,
        result: "success",
        completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false }
      }
    },
    cleanupComplete: true
  } as const;
}

function completed(file: string): boolean {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT state FROM demands").get()?.state === "completed";
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
