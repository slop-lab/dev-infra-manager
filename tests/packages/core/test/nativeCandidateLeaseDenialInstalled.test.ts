import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeQemuHostAssignment } from "../../../../core/packages/core/src/nativeQemuHostClient.js";
import { refreshBundleReviewWriter, reviewProposalRef } from "../../native-git/test/nativeBundleReviewFixture.js";
import { runGit } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { qemuBrokerFixture, type QemuBrokerFixture } from "./nativeCandidateLeaseBrokerFixture.js";

const fixtures: QemuBrokerFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("installed native candidate lease denial", () => {
  it("returns conflict for a stale QEMU authority tuple without mutating state", async () => {
    // Given
    const { fixture, assignment } = await activeAssignment();
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "commit", "--allow-empty", "-m", "stale"]);
    await refreshBundleReviewWriter(fixture.native);
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const statePath = join(fixture.native.root, "native-idle.sqlite3");
    const qemuPath = join(fixture.native.root, "project-a", "root.git", "dim-authoritative-qemu", "state.json");
    const before = await Promise.all([readFile(statePath), readFile(qemuPath)]);

    // When
    const response = await candidateLease(fixture, assignment);

    // Then
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "candidate authority tuple is stale" });
    expect(await Promise.all([readFile(statePath), readFile(qemuPath)])).toEqual(before);
  }, 45_000);

  it("returns not found for a revoked QEMU authority tuple without mutating state", async () => {
    // Given
    const { fixture, assignment, signal } = await activeAssignment();
    await fixture.host.recover(String(assignment.claim.claimId), signal);
    const statePath = join(fixture.native.root, "native-idle.sqlite3");
    const qemuPath = join(fixture.native.root, "project-a", "root.git", "dim-authoritative-qemu", "state.json");
    const before = await Promise.all([readFile(statePath), readFile(qemuPath)]);

    // When
    const response = await candidateLease(fixture, assignment);

    // Then
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(await Promise.all([readFile(statePath), readFile(qemuPath)])).toEqual(before);
  }, 45_000);

  it("preserves an unexpected QEMU authority read failure as internal error", async () => {
    // Given
    const { fixture, assignment } = await activeAssignment();
    const qemuPath = join(fixture.native.root, "project-a", "root.git", "dim-authoritative-qemu", "state.json");
    await writeFile(qemuPath, "{\n");
    const before = await readFile(qemuPath);

    // When
    const response = await candidateLease(fixture, assignment);

    // Then
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal server error" });
    expect(await readFile(qemuPath)).toEqual(before);
  }, 45_000);
});

async function activeAssignment(): Promise<{ readonly fixture: QemuBrokerFixture;
  readonly assignment: NativeQemuHostAssignment; readonly signal: AbortSignal }> {
  const fixture = await qemuBrokerFixture();
  fixtures.push(fixture);
  const signal = AbortSignal.timeout(20_000);
  await fixture.host.attest(signal);
  const assignment = await fixture.host.claim(crypto.randomUUID(), signal);
  if (assignment === undefined) throw new TypeError("QEMU assignment is missing");
  return { fixture, assignment, signal };
}

function candidateLease(fixture: QemuBrokerFixture, assignment: NativeQemuHostAssignment): Promise<Response> {
  const descriptor = assignment.attempt.descriptor;
  const event = assignment.claim.event;
  const reviewId = typeof event === "object" && event !== null ? Reflect.get(event, "reviewId") : undefined;
  if (typeof reviewId !== "string") throw new TypeError("QEMU review ID is missing");
  const credential = fixture.config.nativeGit.candidateReader;
  return fetch(`${fixture.native.service.origin}/v1/candidate-read-leases`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      executionKind: "qemu",
      projectId: descriptor.projectId,
      reviewId,
      jobName: descriptor.jobName,
      attemptId: assignment.attempt.attemptId,
      descriptorDigest: assignment.attempt.descriptorDigest,
      hostId: assignment.claim.hostId,
      capacity: assignment.claim.capacity
    })
  });
}
