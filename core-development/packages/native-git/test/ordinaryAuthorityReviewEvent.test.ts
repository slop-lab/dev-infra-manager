import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewEnvelope, type NativeReviewJobEvent } from "../../../../core/packages/native-git/src/review-event-schema.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];
const requestId = "00000000-0000-4000-8000-000000000003";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native Git ordinary authority review-event proof", () => {
  it("returns exact canonical stored event bytes without changing the immutable review or refs", async () => {
    // Given
    const fixture = await startFixture();
    const { reviewId, event, path } = await storedEvent(fixture, "source");
    const reviewBefore = await readFile(path);
    const protectedBefore = await revParse(fixture, "refs/heads/main");
    const proposalBefore = await revParse(fixture, fixture.proposalRef);

    // When
    const response = await eventProof(fixture, { eventId: event.eventId, reviewId, jobName: event.jobName });
    const responseBytes = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.byteLength(responseBytes, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(responseBytes).toBe(`${JSON.stringify({
      schemaVersion: 1,
      serviceId: "native-main",
      requestId,
      event
    })}\n`);
    expect(await readFile(path)).toEqual(reviewBefore);
    expect(await revParse(fixture, "refs/heads/main")).toBe(protectedBefore);
    expect(await revParse(fixture, fixture.proposalRef)).toBe(proposalBefore);
  });

  it("conceals nonexistent, fabricated, foreign, review-mismatched, and job-mismatched selectors", async () => {
    // Given
    const fixture = await startFixture();
    const { reviewId, event } = await storedEvent(fixture, "source");
    const selectors = [
      { eventId: "00000000-0000-4000-8000-000000000099", reviewId, jobName: "source" },
      { eventId: event.eventId, reviewId: "f".repeat(64), jobName: "source" },
      { eventId: event.eventId, reviewId, jobName: "security" }
    ];

    // When
    const denied = await Promise.all([
      ...selectors.map((selector) => eventProof(fixture, selector)),
      fixture.request(
        "ordinary-identity",
        "POST",
        "/v1/projects/project-b/repositories/source/ordinary-authority/review-event",
        proofBody({ eventId: event.eventId, reviewId, jobName: event.jobName })
      )
    ]);

    // Then
    expect(denied.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    await Promise.all(denied.map(async (response) => expect(await response.text()).toBe("")));
  });

  it("conflicts when policy drift or a moved proposal makes the stored event stale", async () => {
    // Given
    const policyFixture = await startFixture();
    const policyEvent = await storedEvent(policyFixture, "source");
    await policyFixture.restart(policyFixture.configWithPolicyRevision("policy-2"));
    const proposalFixture = await startFixture();
    const proposalEvent = await storedEvent(proposalFixture, "source");
    await writeLateProposal(proposalFixture);

    // When
    const policyDrift = await eventProof(policyFixture, policyEvent);
    const movedProposal = await eventProof(proposalFixture, proposalEvent);

    // Then
    expect(policyDrift.status).toBe(409);
    expect(movedProposal.status).toBe(409);
    expect(await policyDrift.text()).toBe("");
    expect(await movedProposal.text()).toBe("");
  });

  it("rejects generic roles and non-exact request surfaces without exposing or mutating the event", async () => {
    // Given
    const fixture = await startFixture();
    const { reviewId, event, path } = await storedEvent(fixture, "source");
    const before = await readFile(path);
    const route = "/v1/projects/project-a/repositories/source/ordinary-authority/review-event";
    const roles = ["admin-a", "ci-a", "native-main", "ordinary-attempts", "ordinary-results", "reviewer-a-user", "scheduler-a", "source-ci", "writer-a"];

    // When
    const deniedRoles = await Promise.all(roles.map((role) => fixture.request(role, "POST", route, proofBody(event))));
    const wrongMethod = await fixture.request("ordinary-identity", "GET", route);
    const query = await fixture.request("ordinary-identity", "POST", `${route}?event=${event.eventId}`, proofBody(event));
    const contentType = await fetch(`${fixture.baseUrl()}${route}`, {
      method: "POST",
      headers: {
    Authorization: `Basic ${Buffer.from(
      "ordinary-identity:identity-secret-00000000000000000000",
      "utf8"
    ).toString("base64")}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(proofBody(event))
    });
    const executableSelector = await fixture.request("ordinary-identity", "POST", route, {
      ...proofBody(event),
      image: "registry.example/unsafe@sha256:deadbeef",
      command: ["sh"],
      admin: true
    });
    const oversized = await fixture.request("ordinary-identity", "POST", route, {
      ...proofBody(event),
      executable: "x".repeat(65 * 1024)
    });

    // Then
    expect(deniedRoles.map((response) => response.status)).toEqual(roles.map(() => 401));
    expect(wrongMethod.status).toBe(404);
    expect(query.status).toBe(404);
    expect(contentType.status).toBe(400);
    expect(executableSelector.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(await readFile(path)).toEqual(before);
    expect(reviewId).toBe(event.reviewId);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function storedEvent(
  fixture: ReviewFixture,
  jobName: string
): Promise<{ readonly reviewId: string; readonly eventId: string; readonly jobName: string; readonly event: NativeReviewJobEvent; readonly path: string }> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  const reviewId = stringField(await readJsonObject(response), "reviewId");
  const path = join(fixture.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`);
  const envelope = parseReviewEnvelope(JSON.parse(await readFile(path, "utf8")));
  const event = envelope.events.find((candidate) => candidate.jobName === jobName);
  if (event === undefined) throw new Error(`stored event was not found for job: ${jobName}`);
  return { reviewId, eventId: event.eventId, jobName: event.jobName, event, path };
}

function eventProof(
  fixture: ReviewFixture,
  selector: { readonly eventId: string; readonly reviewId: string; readonly jobName: string }
): Promise<Response> {
  return fixture.request(
    "ordinary-identity",
    "POST",
    "/v1/projects/project-a/repositories/source/ordinary-authority/review-event",
    proofBody(selector)
  );
}

function proofBody(selector: { readonly eventId: string; readonly reviewId: string; readonly jobName: string }) {
  return {
    schemaVersion: 1,
    requestId,
    eventId: selector.eventId,
    reviewId: selector.reviewId,
    jobName: selector.jobName
  };
}

async function revParse(fixture: ReviewFixture, ref: string): Promise<string> {
  return (await fixture.git(fixture.repositoryPath, ["rev-parse", ref])).stdout.trim();
}

async function writeLateProposal(fixture: ReviewFixture): Promise<void> {
  await fixture.git(fixture.clone, ["commit", "--allow-empty", "-m", "move proposal"]);
  await fixture.git(fixture.clone, ["push", "origin", `HEAD:${fixture.proposalRef}`]);
}
