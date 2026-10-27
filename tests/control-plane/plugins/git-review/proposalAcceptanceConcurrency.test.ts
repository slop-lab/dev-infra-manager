import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope
} from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";
import {
  completeProposalAcceptance,
  failProposalAcceptance,
  proposalAcceptanceState,
  recoverProposalAcceptances,
  stageProposalAcceptance
} from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance.js";
import * as acceptanceStorage from "../../../../packages/control-plane/plugins/git-review/src/proposal-acceptance-storage.js";
import * as recordStorage from "../../../../packages/control-plane/plugins/git-review/src/review-record-storage.js";
import {
  createAuthoritativeNativeReview,
  reviewChangeMatchers,
  type ReviewPreparation
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  fixture,
  generationId,
  git
} from "../git-repositories/optionalFeaturesFixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("serializes state and completion behind a live acceptance publication", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-proposal-acceptance-race-"));
  roots.push(repository);
  const selected = envelope("live-stage");
  const originalPublish = recordStorage.publishReviewRecord;
  let publicationStarted: (() => void) | undefined;
  let releasePublication: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
  const release = new Promise<void>((resolve) => { releasePublication = resolve; });
  vi.spyOn(recordStorage, "publishReviewRecord").mockImplementation((publication) => originalPublish({
    ...publication,
    faults: { ...publication.faults, async beforePublish() { publicationStarted?.(); await release; } }
  }));
  const stage = stageProposalAcceptance(repository, generationId, selected);
  await started;
  let stateSettled = false;
  let completionSettled = false;

  // When
  const state = proposalAcceptanceState(repository, generationId, selected).finally(() => { stateSettled = true; });
  const completion = completeProposalAcceptance(repository, generationId, selected)
    .finally(() => { completionSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Then
  expect(stateSettled).toBe(false);
  expect(completionSettled).toBe(false);
  releasePublication?.();
  await expect(stage).resolves.toBeUndefined();
  await expect(state).resolves.toBe("pending");
  await expect(completion).resolves.toBeUndefined();
  expect(await proposalAcceptanceState(repository, generationId, selected)).toBe("none");
  expect(await readdir(join(repository, "dim-proposal-acceptance", "staging"))).toEqual([]);
});

it("continues recovery after durably marking one accepted-hook failure", async () => {
  // Given
  const f = await fixture(true);
  const repository = join(f.root, "state", "project", "main.git");
  const candidateCommit = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD"])).stdout.trim();
  const proposalRefs = ["refs/heads/recovery-one", "refs/heads/recovery-two"] as const;
  let releaseAcceptance: (() => void) | undefined;
  try {
    for (const proposalRef of proposalRefs) {
      await f.service.context.mutate({ projectId: "project", repositoryId: "main" }, async () => {
        await git("/usr/bin/git", ["--git-dir", repository, "update-ref", proposalRef, candidateCommit]);
      });
    }
    let acceptedCalls = 0;
    let failedEnvelopeId: string | undefined;
    let acceptanceStarted: (() => void) | undefined;
    const acceptedStarted = new Promise<void>((resolve) => { acceptanceStarted = resolve; });
    const acceptanceRelease = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    const preparation: ReviewPreparation = {
      name: "acceptance-test",
      async prepare() { return { inputs: {} }; },
      async accepted(input) {
        acceptedCalls += 1;
        if (acceptedCalls === 1) {
          failedEnvelopeId = input.envelope.envelopeId;
          acceptanceStarted?.();
          await acceptanceRelease;
          throw new RecoveryFixtureError();
        }
      }
    };
    const runtime = { ...f.service.context.runtime, authoritativeTargetProofs: new Map(),
      reviewPreparations: [preparation], reviewChangeMatchers: reviewChangeMatchers(f.extensions) };
    const staged: AuthoritativeNativeReviewEnvelope[] = [];
    for (const proposalRef of proposalRefs) {
      await expect(createAuthoritativeNativeReview(runtime, { projectId: "project", repositoryId: "main", proposalRef }, {
        async beforePublication({ repository: target, envelope: selected }) {
          staged.push(selected);
          await stageProposalAcceptance(target, generationId, selected);
          throw new RecoveryFixtureError();
        }
      })).rejects.toThrow();
    }

    // When
    const recovery = recoverProposalAcceptances(runtime, join(f.root, "state"),
      (scope, operation) => f.service.context.mutate(scope, operation));
    await acceptedStarted;
    const concurrentlyCompleted = staged.find(({ envelopeId }) => envelopeId !== failedEnvelopeId);
    if (concurrentlyCompleted === undefined) throw new RecoveryFixtureError();
    await stageProposalAcceptance(repository, generationId, concurrentlyCompleted);
    expect(await proposalAcceptanceState(repository, generationId, concurrentlyCompleted)).toBe("pending");
    await completeProposalAcceptance(repository, generationId, concurrentlyCompleted);
    releaseAcceptance?.();
    await recovery;

    // Then
    expect(acceptedCalls).toBe(2);
    const failed = staged.find(({ envelopeId }) => envelopeId === failedEnvelopeId);
    const completed = staged.find(({ envelopeId }) => envelopeId !== failedEnvelopeId);
    if (failed === undefined || completed === undefined) throw new RecoveryFixtureError();
    expect(await proposalAcceptanceState(repository, generationId, failed)).toBe("failed");
    expect(await proposalAcceptanceState(repository, generationId, completed)).toBe("none");
  } finally {
    releaseAcceptance?.();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("propagates a failed-marker storage error", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-proposal-acceptance-marker-"));
  roots.push(repository);
  const selected = envelope("marker-failure");
  await stageProposalAcceptance(repository, generationId, selected);
  const markerError = new RecoveryFixtureError();
  const originalPublish = recordStorage.publishReviewRecord;
  vi.spyOn(recordStorage, "publishReviewRecord").mockImplementation((publication) => {
    if (publication.path.includes("/failed/")) return Promise.reject(markerError);
    return originalPublish(publication);
  });

  // When
  const failure = failProposalAcceptance(repository, generationId, selected);

  // Then
  await expect(failure).rejects.toBe(markerError);
  expect(await proposalAcceptanceState(repository, generationId, selected)).toBe("pending");
});

it("admits an exact stored name before enforcing the directory bound", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-proposal-acceptance-admission-"));
  roots.push(repository);
  await stageProposalAcceptance(repository, generationId, envelope("admission-boundary"));
  const pending = join(repository, "dim-proposal-acceptance", "pending");
  const exactName = (await readdir(pending))[0];
  if (exactName === undefined) throw new RecoveryFixtureError();
  const newName = exactName === `${"f".repeat(64)}.json` ? `${"e".repeat(64)}.json` : `${"f".repeat(64)}.json`;

  // When / Then
  await expect(acceptanceStorage.admitProposalAcceptanceRecord(pending, exactName, 1)).resolves.toBe("existing");
  await expect(acceptanceStorage.admitProposalAcceptanceRecord(pending, newName, 1)).rejects.toThrow(/capacity/);
});

it("rejects a new pending record at capacity while admitting an exact duplicate", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-proposal-acceptance-pending-capacity-"));
  roots.push(repository);
  const accepted = envelope("accepted-at-capacity");
  const rejected = envelope("rejected-at-capacity");
  await stageProposalAcceptance(repository, generationId, accepted);
  const pending = join(repository, "dim-proposal-acceptance", "pending");
  const exactName = (await readdir(pending))[0];
  if (exactName === undefined) throw new RecoveryFixtureError();
  const originalAdmission = acceptanceStorage.admitProposalAcceptanceRecord;
  const admission = vi.spyOn(acceptanceStorage, "admitProposalAcceptanceRecord")
    .mockImplementation((directory, recordName, maximumRecords) => {
      if (directory !== pending) return originalAdmission(directory, recordName, maximumRecords);
      if (recordName === exactName) return Promise.resolve("existing");
      return Promise.reject(new acceptanceStorage.ProposalAcceptanceStorageError("proposal acceptance capacity exceeded"));
    });

  // When / Then
  await expect(stageProposalAcceptance(repository, generationId, accepted)).resolves.toBeUndefined();
  await expect(stageProposalAcceptance(repository, generationId, rejected)).rejects.toThrow(/capacity/);
  admission.mockRestore();
  expect(await readdir(pending)).toEqual([exactName]);
  expect(await proposalAcceptanceState(repository, generationId, rejected)).toBe("none");
});

it("rejects a new failed marker at capacity while admitting an exact duplicate", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-proposal-acceptance-failed-capacity-"));
  roots.push(repository);
  const accepted = envelope("accepted-failure-at-capacity");
  const rejected = envelope("rejected-failure-at-capacity");
  await stageProposalAcceptance(repository, generationId, accepted);
  await stageProposalAcceptance(repository, generationId, rejected);
  await failProposalAcceptance(repository, generationId, accepted);
  const failed = join(repository, "dim-proposal-acceptance", "failed");
  const exactName = (await readdir(failed))[0];
  if (exactName === undefined) throw new RecoveryFixtureError();
  const originalAdmission = acceptanceStorage.admitProposalAcceptanceRecord;
  const admission = vi.spyOn(acceptanceStorage, "admitProposalAcceptanceRecord")
    .mockImplementation((directory, recordName, maximumRecords) => {
      if (directory !== failed) return originalAdmission(directory, recordName, maximumRecords);
      if (recordName === exactName) return Promise.resolve("existing");
      return Promise.reject(new acceptanceStorage.ProposalAcceptanceStorageError("proposal acceptance capacity exceeded"));
    });

  // When / Then
  await expect(failProposalAcceptance(repository, generationId, accepted)).resolves.toBeUndefined();
  await expect(failProposalAcceptance(repository, generationId, rejected)).rejects.toThrow(/capacity/);
  admission.mockRestore();
  expect(await readdir(failed)).toEqual([exactName]);
  expect(await proposalAcceptanceState(repository, generationId, accepted)).toBe("failed");
  expect(await proposalAcceptanceState(repository, generationId, rejected)).toBe("pending");
});

function envelope(name: string): AuthoritativeNativeReviewEnvelope {
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  return createAuthoritativeNativeReviewEnvelope({ identity: {
    schemaVersion: 2, serviceId: "native-main", projectId: "project", repositoryId: "main", inputs: { main: snapshot },
    protectedRef: "refs/heads/main", proposalRef: `refs/heads/${name}`, expectedProtectedHead: "1".repeat(40),
    candidateCommit: snapshot.commit, candidateTree: snapshot.tree, policyRevision: "4".repeat(64),
    requiredReviewRevision: "5".repeat(64), requiredReviewerIds: [], changes: [], patch: "", patchBytes: ""
  }, policyDigest: "6".repeat(64), attachments: [], createdAt: "2026-10-27T00:00:00.000Z" });
}

class RecoveryFixtureError extends Error {
  readonly name = "RecoveryFixtureError";
}
