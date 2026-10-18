import { candidateArgv } from "@slop-lab/dim-plugin-ci-workflows";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNativeQemuAuthorityStore, NativeQemuAuthorityState,
  type NativeQemuAuthorityPublicationFaults }
  from "../../../../core/packages/native-git/src/native-qemu-authority-state.js";
import { qemuExecutionDescriptorDigest, qemuExecutionDescriptorSchema } from "../../../../core/packages/native-git/src/qemu-execution-descriptor.js";
import { activateFinalizeService, cleanupFinalizeFixtures, closeFinalizeService, generationId, importer,
  projectInput, rootRepository, startFinalizeService } from "./nativeRootImportFinalizeFixture.js";

const reviewId = "1".repeat(64);
const descriptor = qemuExecutionDescriptorSchema.parse({
  schemaVersion: 1, executionKind: "qemu", admissionGeneration: "generation-a", jobName: "integration",
  runnerBaseImage: `registry.example/runner@sha256:${"2".repeat(64)}`,
  bounds: { cpu: "2", memoryBytes: "1024", pids: "64", wallClockSeconds: "60", outputBytes: "1024" },
  projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main",
  expectedProtectedHead: "3".repeat(40), candidateCommit: "4".repeat(40), candidateTree: "5".repeat(40),
  policyRevision: "policy-a", requiredReviewRevision: "review-a", requiredJobSetRevision: "jobs-a",
  evidenceClass: "candidate-controlled", configBlob: { path: ".dim/ci/runner.yml", objectId: "6".repeat(40), sha256: `sha256:${"7".repeat(64)}` },
  script: { path: ".dim/ci/jobs/integration.bash", objectId: "8".repeat(40), sha256: `sha256:${"9".repeat(64)}` },
  argv: candidateArgv, jobImage: `registry.example/job@sha256:${"a".repeat(64)}`
});
const descriptorDigest = qemuExecutionDescriptorDigest(descriptor);
const roots: string[] = [];

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native QEMU authority state", () => {
  it("durably replays one issuance and immutable status in the QEMU-only namespace", async () => {
    const repository = await mkdtemp(join(tmpdir(), "native-qemu-authority-"));
    const state = new NativeQemuAuthorityState(repository);
    const issuanceRequestId = "00000000-0000-4000-8000-000000000001";
    const issued = await state.issue({ issuanceRequestId, reviewId, descriptor, descriptorDigest,
      hostId: "host-a", capacity: "kvm-a" });
    const replayed = await new NativeQemuAuthorityState(repository).issue({ issuanceRequestId, reviewId,
      descriptor, descriptorDigest, hostId: "host-a", capacity: "kvm-a" });
    const status = { schemaVersion: 1 as const, executionKind: "qemu" as const,
      eventId: "00000000-0000-4000-8000-000000000002", attemptId: issued.attemptId, descriptorDigest,
      result: "success" as const, event: { executionKind: "qemu", attemptId: issued.attemptId } };

    expect(replayed).toEqual(issued);
    expect(await state.status(status)).toEqual(status);
    expect(await new NativeQemuAuthorityState(repository).status(status)).toEqual(status);
    const stored: unknown = JSON.parse(await readFile(join(repository, "dim-authoritative-qemu", "state.json"), "utf8"));
    expect(stored).toMatchObject({ schemaVersion: 1, attempts: [{ executionKind: "qemu" }],
      statuses: [{ executionKind: "qemu" }] });
  });

  it("rejects a conflicting result and any status after revocation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "native-qemu-authority-"));
    const state = new NativeQemuAuthorityState(repository);
    const issued = await state.issue({ issuanceRequestId: "00000000-0000-4000-8000-000000000011",
      reviewId, descriptor, descriptorDigest, hostId: "host-a", capacity: "kvm-a" });
    await state.revoke(reviewId, descriptor.jobName, issued.attemptId);

    await expect(state.status({ schemaVersion: 1, executionKind: "qemu",
      eventId: "00000000-0000-4000-8000-000000000012", attemptId: issued.attemptId, descriptorDigest,
      result: "failure", event: {} })).rejects.toThrow("does not match a current attempt");
  });

  it.each([
    { phase: "beforeFileSync", recoverable: false },
    { phase: "beforeRename", recoverable: true },
    { phase: "beforeDirectorySync", recoverable: true }
  ] as const)("preserves evidence and acknowledges only a durable issue across $phase", async ({ phase, recoverable }) => {
    // Given
    const repository = await temporaryRepository();
    const faults: NativeQemuAuthorityPublicationFaults = {
      [phase]: () => { throw new InjectedQemuStateCrashError(phase); }
    };
    const state = new NativeQemuAuthorityState(repository, faults);

    // When
    await expect(state.issue(issueInput("00000000-0000-4000-8000-000000000021")))
      .rejects.toEqual(new InjectedQemuStateCrashError(phase));

    // Then
    const directory = authorityDirectory(repository);
    const evidenceBefore = await directoryEvidence(directory);
    expect(evidenceBefore).not.toEqual([]);
    const restarted = new NativeQemuAuthorityState(repository);
    if (recoverable) {
      const snapshot = await restarted.snapshot();
      expect(snapshot.attempts).toHaveLength(1);
      expect((await readdir(directory)).sort()).toEqual(["state.json"]);
      await expect(restarted.issue(issueInput("00000000-0000-4000-8000-000000000021")))
        .resolves.toEqual(snapshot.attempts[0]);
    } else {
      await expect(restarted.snapshot()).rejects.toThrow(/QEMU authority/i);
      expect(await directoryEvidence(directory)).toEqual(evidenceBefore);
    }
  });

  it("recovers a status publication interrupted after rename without inventing unknown or revoked status", async () => {
    // Given
    const repository = await temporaryRepository();
    const baseline = new NativeQemuAuthorityState(repository);
    const issued = await baseline.issue(issueInput("00000000-0000-4000-8000-000000000031"));
    const status = statusRecord(issued.attemptId, "00000000-0000-4000-8000-000000000032");
    const interrupted = new NativeQemuAuthorityState(repository, {
      beforeDirectorySync: () => { throw new InjectedQemuStateCrashError("beforeDirectorySync"); }
    });

    // When
    await expect(interrupted.status(status)).rejects.toEqual(new InjectedQemuStateCrashError("beforeDirectorySync"));

    // Then
    const restarted = new NativeQemuAuthorityState(repository);
    expect((await restarted.snapshot()).statuses).toEqual([status]);
    await expect(restarted.status({ ...status, eventId: "00000000-0000-4000-8000-000000000033" }))
      .rejects.toThrow("already has another status");
    await restarted.revoke(reviewId, descriptor.jobName, issued.attemptId);
    await expect(restarted.status({ ...status, eventId: "00000000-0000-4000-8000-000000000034" }))
      .rejects.toThrow("already has another status");
    await expect(restarted.status(statusRecord("00000000-0000-4000-8000-000000000099",
      "00000000-0000-4000-8000-000000000035"))).rejects.toThrow("does not match a current attempt");
  });

  it.each(["missing-final", "foreign-staging", "corrupt-staging", "wrong-mode"] as const)(
    "fails closed and preserves %s publication evidence",
    async (kind) => {
      // Given
      const repository = await temporaryRepository();
      const state = new NativeQemuAuthorityState(repository);
      await state.issue(issueInput("00000000-0000-4000-8000-000000000041"));
      const directory = authorityDirectory(repository);
      const finalPath = join(directory, "state.json");
      let evidencePath = finalPath;
      if (kind === "missing-final") {
        await unlink(finalPath);
      } else if (kind === "foreign-staging") {
        evidencePath = join(directory, "foreign.tmp");
        await writeFile(evidencePath, "foreign\n", { mode: 0o600 });
      } else if (kind === "corrupt-staging") {
        evidencePath = join(directory,
          `.state.json.${"0".repeat(64)}.00000000-0000-4000-8000-000000000000.tmp`);
        await writeFile(evidencePath, "{", { mode: 0o600 });
      } else {
        await chmod(finalPath, 0o640);
      }
      const before = await directoryEvidence(directory);

      // When / Then
      await expect(assertNativeQemuAuthorityStore(repository)).rejects.toThrow(/QEMU authority/i);
      expect(await directoryEvidence(directory)).toEqual(before);
      if (kind !== "missing-final") expect((await lstat(evidencePath)).isFile()).toBe(true);
    }
  );

  it("rejects a corrupt registered-root QEMU store before service startup", async () => {
    // Given
    const root = await mkdtemp("/tmp/native-qemu-startup-");
    roots.push(root);
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    await closeFinalizeService(service);
    const repository = rootRepository(root);
    const directory = authorityDirectory(repository);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "state.json");
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, attempts: [], statuses: [{ foreign: true }] })}\n`,
      { mode: 0o600 });
    const before = await readFile(path);

    // When / Then
    await expect(startFinalizeService(root)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  }, 30_000);
});

function issueInput(issuanceRequestId: string) {
  return { issuanceRequestId, reviewId, descriptor, descriptorDigest, hostId: "host-a", capacity: "kvm-a" };
}

function statusRecord(attemptId: string, eventId: string) {
  return { schemaVersion: 1 as const, executionKind: "qemu" as const, eventId, attemptId, descriptorDigest,
    result: "success" as const, event: { executionKind: "qemu", attemptId } };
}

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp("/tmp/native-qemu-authority-");
  roots.push(repository);
  return repository;
}

function authorityDirectory(repository: string): string {
  return join(repository, "dim-authoritative-qemu");
}

async function directoryEvidence(directory: string): Promise<readonly object[]> {
  const entries = await readdir(directory);
  return Promise.all(entries.sort().map(async (name) => {
    const metadata = await stat(join(directory, name));
    return { name, ino: metadata.ino, mode: metadata.mode, nlink: metadata.nlink, size: metadata.size,
      bytes: await readFile(join(directory, name), "utf8") };
  }));
}

class InjectedQemuStateCrashError extends Error {
  readonly name = "InjectedQemuStateCrashError";
  constructor(readonly phase: string) { super(`injected QEMU state crash at ${phase}`); }
}
