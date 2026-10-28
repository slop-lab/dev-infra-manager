import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope
} from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";
import { readVerifiedCiReviewSources } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("fails closed when one compact verified source exceeds its byte budget", async () => {
  // Given
  const repository = await createRepository();
  const stored = oversizedEnvelope();
  await writeRecord(repository, stored);

  // When / Then
  await expect(readVerifiedCiReviewSources(repository, stored.review.reviewId))
    .rejects.toThrow("verified CI review source capacity is exhausted");
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "dim-verified-review-capacity-"));
  roots.push(repository);
  await mkdir(join(repository, "dim-authoritative-reviews", "proposals"), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, "dim-authoritative-reviews", "staging"), { mode: 0o700 });
  return repository;
}

async function writeRecord(repository: string, stored: AuthoritativeNativeReviewEnvelope): Promise<void> {
  const path = join(repository, "dim-authoritative-reviews", "proposals",
    `${stored.review.reviewId}.${stored.envelopeId}.json`);
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

function oversizedEnvelope(): AuthoritativeNativeReviewEnvelope {
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  const requiredReviewerIds = Array.from({ length: 20_000 }, (_, index) =>
    `r${index.toString().padStart(5, "0")}${"x".repeat(56)}`);
  return createAuthoritativeNativeReviewEnvelope({
    identity: {
      schemaVersion: 2, serviceId: "native-main", projectId: "project", repositoryId: "main",
      inputs: { main: snapshot }, protectedRef: "refs/heads/main", proposalRef: "refs/heads/capacity",
      expectedProtectedHead: "1".repeat(40), candidateCommit: snapshot.commit, candidateTree: snapshot.tree,
      policyRevision: "4".repeat(64), requiredReviewRevision: "5".repeat(64), requiredReviewerIds,
      changes: [], patch: "", patchBytes: ""
    },
    policyDigest: "6".repeat(64), attachments: [], createdAt: "2026-10-28T00:00:00.000Z"
  });
}
