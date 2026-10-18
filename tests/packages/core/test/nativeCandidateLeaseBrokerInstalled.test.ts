import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeGitCandidateReadAuthority } from "../../../../core/packages/managed/src/nativeGitCandidateReadAuthority.js";
import { createNativeRootCiHostClient } from "../../../../core/packages/managed/src/nativeRootCiHostClient.js";
import { NativeRootCiHostJournal } from "../../../../core/packages/managed/src/nativeRootCiHostJournal.js";
import { plannedNativeHostPrivateRoot } from "../../../../core/packages/managed/src/nativeOrdinaryExecutorRoot.js";
import type { NativeQemuHostAssignment } from "../../../../core/packages/managed/src/nativeQemuHostClient.js";
import { NativeQemuHostJournal } from "../../../../core/packages/managed/src/nativeQemuHostJournal.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { rootRepository, runGit } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { qemuBrokerFixture, type QemuBrokerFixture } from "./nativeCandidateLeaseBrokerFixture.js";
import { reservationFixture, type ReservationFixture } from "./nativeRootClaimReservationFixture.js";

const fixtures: ReservationFixture[] = [];
const temporaryRoots: string[] = [];
const qemuFixtures: QemuBrokerFixture[] = [];
const run = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(qemuFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed native candidate lease broker", () => {
  it("lets a nonowner ordinary host materialize exact candidate bytes using only its host token", async () => {
    // Given
    const fixture = await reservationFixture("candidate-lease-ordinary");
    fixtures.push(fixture);
    const client = createNativeRootCiHostClient({
      hostId: "host-b",
      capacity: "backup",
      generationId,
      ordinaryCi: {
        endpoint: fixture.origin,
        serviceId: "ordinary-main",
        credential: { username: "host-b", password: Buffer.alloc(32, 83).toString("base64url") }
      },
      nativeGit: { endpoint: fixture.nativeOrigin, serviceId: "native-main" }
    });
    const signal = AbortSignal.timeout(10_000);
    const claim = await client.reserve(client.prepareClaim(randomUUID()), signal);
    if (claim === undefined) throw new TypeError("ordinary claim is missing");
    const issuance = await client.issue(claim, signal);
    const active = await client.activate(client.prepareActivation(claim, issuance, randomUUID()), signal);
    const lease = await client.candidateLease(active, randomUUID(), signal);
    const root = await mkdtemp(join(tmpdir(), "dim-native-candidate-ordinary-"));
    temporaryRoots.push(root);
    await new NativeRootCiHostJournal(join(root, "journal.json")).save({ kind: "active", claim, active,
      privateRoot: plannedNativeHostPrivateRoot(randomUUID()) });
    const destination = join(root, "workspace");
    const descriptor = issuance.descriptor;
    const authority = createNativeGitCandidateReadAuthority({
      gitExecutable: "/usr/bin/git",
      serviceEndpoint: fixture.nativeOrigin,
      credential: lease,
      temporaryRoot: root,
      claim: {
        projectId: descriptor.projectId,
        repositoryId: descriptor.repositoryId,
        protectedRef: descriptor.protectedRef,
        expectedProtectedHead: descriptor.expectedProtectedHead,
        candidateCommit: descriptor.candidateCommit,
        candidateTree: descriptor.candidateTree
      }
    });

    // When
    const materialized = await authority.materializeTree({
      projectId: descriptor.projectId,
      repositoryId: descriptor.repositoryId,
      commitObjectId: descriptor.candidateCommit,
      treeObjectId: descriptor.candidateTree,
      destination,
      signal
    });

    // Then
    expect(claim.hostId).toBe("host-b");
    expect(claim.hostId).not.toBe("host-a");
    expect(active.assignment).toMatchObject({
      attemptId: issuance.attemptId,
      descriptorDigest: issuance.descriptorDigest,
      hostId: "host-b",
      capacity: "backup"
    });
    expect(materialized).toEqual({
      commitObjectId: descriptor.candidateCommit,
      treeObjectId: descriptor.candidateTree
    });
    expect(await readFile(join(destination, "candidate.bin"))).toEqual(Buffer.from([0, 255, 1, 254]));
    const persisted = await fileBytes(fixture.root);
    const hostFiles = await fileBytes(root);
    expect(persisted).not.toContain(lease.password);
    expect(hostFiles).not.toContain(lease.password);
    expect(hostFiles).not.toContain(bundleSecrets.attemptIssuer);
    expect(hostFiles).not.toContain(bundleSecrets.projectRootReadIssuer);
    expect(persisted).not.toContain(bundleSecrets.attemptIssuer);
    expect(persisted).not.toContain(bundleSecrets.projectRootReadIssuer);
    expect(JSON.stringify({ hostId: client.hostId, capacity: client.capacity, nativeGit: {
      endpoint: fixture.nativeOrigin, serviceId: "native-main" } })).not.toMatch(
      new RegExp(`${bundleSecrets.attemptIssuer}|${bundleSecrets.projectRootReadIssuer}`)
    );
  }, 30_000);

  it("binds a QEMU host lease to its active claim and denies every authority escalation", async () => {
    // Given
    const fixture = await qemuBrokerFixture();
    qemuFixtures.push(fixture);
    const signal = AbortSignal.timeout(20_000);
    await fixture.host.attest(signal);
    const assignment = await fixture.host.claim(randomUUID(), signal);
    if (assignment === undefined) throw new TypeError("QEMU assignment is missing");
    const lease = await fixture.host.candidateLease(assignment, signal);
    const privateRoot = await mkdtemp(join(tmpdir(), "dim-native-candidate-qemu-"));
    temporaryRoots.push(privateRoot);
    await new NativeQemuHostJournal(join(privateRoot, "journal.json")).save({ kind: "active", assignment });
    const destination = join(privateRoot, "workspace");
    const descriptor = assignment.attempt.descriptor;
    const authority = candidateAuthority(fixture.native.service.origin, privateRoot, lease, assignment);
    const protectedBefore = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.native.root),
      "rev-parse", "refs/heads/main"])).stdout.trim();

    // When
    await authority.materializeTree({ projectId: descriptor.projectId, repositoryId: descriptor.repositoryId,
      commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree,
      destination, signal });
    await expect(fixture.foreignHost.candidateLease(assignment, signal)).rejects.toThrow(/rejected/);
    const foreignClaim = await schedulerLease(fixture, assignment, randomUUID());
    const wrongBackend = await nativeLease(fixture, assignment);
    const receivePack = await fetch(`${fixture.native.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`${lease.username}:${lease.password}`).toString("base64")}` }
    });
    const expiringLease = await fixture.host.candidateLease(assignment, signal);
    fixture.now.value += 31_000;
    await expect(gitRemote(fixture.native.service.origin, expiringLease)).rejects.toThrow();
    const revocableLease = await fixture.host.candidateLease(assignment, signal);
    await fixture.host.recover(String(assignment.claim.claimId), signal);
    await expect(gitRemote(fixture.native.service.origin, revocableLease)).rejects.toThrow();

    // Then
    expect(assignment.claim).toMatchObject({ hostId: "worker-qemu", capacity: "kvm-main" });
    expect(assignment.attempt).toMatchObject({ attemptId: expect.any(String), descriptorDigest: expect.any(String) });
    expect(await readFile(join(destination, "candidate.bin"))).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(foreignClaim.status).toBe(404);
    expect(wrongBackend.status).toBe(403);
    expect(receivePack.status).toBe(403);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.native.root),
      "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(protectedBefore);
    const persisted = await fileBytes(fixture.root);
    const hostFiles = await fileBytes(privateRoot);
    expect(persisted).not.toContain(lease.password);
    expect(persisted).not.toContain(expiringLease.password);
    expect(persisted).not.toContain(revocableLease.password);
    expect(persisted).not.toContain(fixture.config.nativeGit.attemptIssuer.password);
    expect(hostFiles).not.toContain(lease.password);
    expect(hostFiles).not.toContain(fixture.config.nativeGit.attemptIssuer.password);
    expect(JSON.stringify(fixture.host.connection)).not.toMatch(/attemptIssuer|rootReadIssuer/);
  }, 45_000);
});

function candidateAuthority(origin: string, temporaryRoot: string,
  lease: { readonly username: string; readonly password: string }, assignment: NativeQemuHostAssignment) {
  const descriptor = assignment.attempt.descriptor;
  return createNativeGitCandidateReadAuthority({ gitExecutable: "/usr/bin/git", serviceEndpoint: origin,
    credential: lease, temporaryRoot, claim: { projectId: descriptor.projectId,
      repositoryId: descriptor.repositoryId, protectedRef: descriptor.protectedRef,
      expectedProtectedHead: descriptor.expectedProtectedHead, candidateCommit: descriptor.candidateCommit,
      candidateTree: descriptor.candidateTree } });
}
function authenticatedRemote(origin: string, lease: { readonly username: string; readonly password: string }): string {
  const remote = new URL("/v1/projects/project-a/repositories/root.git", origin);
  remote.username = lease.username; remote.password = lease.password;
  return remote.toString().replace(/\/$/, "");
}
function gitRemote(origin: string, lease: { readonly username: string; readonly password: string }) {
  return run("/usr/bin/git", ["ls-remote", authenticatedRemote(origin, lease)], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  });
}
function schedulerLease(fixture: QemuBrokerFixture, assignment: NativeQemuHostAssignment,
  claimId: string): Promise<Response> {
  return fetch(`${fixture.schedulerOrigin}/v1/qemu-host-candidate-leases`, { method: "POST", headers: {
    authorization: `Basic ${Buffer.from(`worker-qemu:${fixture.config.hosts[0]?.hostToken ?? ""}`).toString("base64")}`,
    "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(),
      claimId, attemptId: assignment.attempt.attemptId, descriptorDigest: assignment.attempt.descriptorDigest }) });
}
function nativeLease(fixture: QemuBrokerFixture, assignment: NativeQemuHostAssignment): Promise<Response> {
  const descriptor = assignment.attempt.descriptor;
  const event = assignment.claim.event;
  const reviewId = typeof event === "object" && event !== null ? Reflect.get(event, "reviewId") : undefined;
  if (typeof reviewId !== "string") throw new TypeError("QEMU review ID is missing");
  return fetch(`${fixture.native.service.origin}/v1/candidate-read-leases`, { method: "POST", headers: {
    authorization: `Basic ${Buffer.from(`ordinary-candidate-reader:${bundleSecrets.candidateReader}`).toString("base64")}`,
    "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(),
      executionKind: "qemu", projectId: descriptor.projectId,
      reviewId, jobName: descriptor.jobName,
      attemptId: assignment.attempt.attemptId, descriptorDigest: assignment.attempt.descriptorDigest,
      hostId: "worker-qemu", capacity: "kvm-main" }) });
}
async function fileBytes(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file)))).map((bytes) => bytes.toString("latin1")).join("\n");
}
