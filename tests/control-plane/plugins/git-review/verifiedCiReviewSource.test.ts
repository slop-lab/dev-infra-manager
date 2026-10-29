import { randomUUID } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuthoritativeNativeReviewStore,
  assertVerifiedCiReviewSourceCurrent,
  readVerifiedCiReviewSources,
  saveAuthoritativeNativeReviewEnvelope
} from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";
import {
  createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope
} from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";
import * as storage from "../../../../packages/gs/review/src/review-record-storage.js";
import { installBodyReadCounter } from "./verifiedReviewSourceReadCounter.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verified CI review source provenance", () => {
  it("issues a frozen compact source from an exact on-demand record", async () => {
    // Given
    const repository = await createRepository();
    const stored = envelope("selected", "2026-10-28T00:00:00.000Z");
    await writeRecord(repository, stored);

    // When
    const sources = await readVerifiedCiReviewSources(repository, stored.review.reviewId);

    // Then
    expect(sources).toHaveLength(1);
    const source = onlySource(sources);
    expect(source?.summary).toEqual({
      schemaVersion: stored.schemaVersion,
      envelopeId: stored.envelopeId,
      review: compactReview(stored),
      policyDigest: stored.policyDigest,
      attachments: stored.attachments
    });
    expect(source?.summary.review).not.toHaveProperty("changes");
    expect(source?.summary.review).not.toHaveProperty("patch");
    expect(source?.summary.review).not.toHaveProperty("patchBytes");
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source?.summary)).toBe(true);
    expect(Object.isFrozen(source?.summary.review.inputs)).toBe(true);
    await expect(assertVerifiedCiReviewSourceCurrent(repository, source)).resolves.toBeUndefined();
    expect(onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId))).toBe(source);
  });

  it("preloads CI startup attestations and refuses to transparently refresh a known file version", async () => {
    // Given
    const repository = await createRepository();
    const stored = envelope("startup", "2026-10-28T00:00:00.000Z");
    const path = await writeRecord(repository, stored);
    await assertAuthoritativeNativeReviewStore(repository);
    await readVerifiedCiReviewSources(repository);
    await appendFile(path, "\n", "utf8");

    // When / Then
    await expect(readVerifiedCiReviewSources(repository, stored.review.reviewId)).rejects.toThrow(/changed|version/i);
  });

  it("reuses an issued targeted source without reading its body again", async () => {
    // Given
    const repository = await createRepository();
    const stored = envelope("warm", "2026-10-28T00:00:00.000Z");
    await writeRecord(repository, stored);
    const counter = await installBodyReadCounter();

    try {
      const first = onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId));
      expect(counter.bytes()).toBeGreaterThan(0);
      counter.reset();

      // When
      const second = onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId));

      // Then
      expect(second).toBe(first);
      expect(counter.bytes()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it("reuses startup-seeded sources for the all-review catalog without body reads", async () => {
    // Given
    const repository = await createRepository();
    const first = envelope("catalog-first", "2026-10-28T00:00:00.000Z");
    const second = envelope("catalog-second", "2026-10-28T00:00:01.000Z");
    await writeRecord(repository, first);
    await writeRecord(repository, second);
    await assertAuthoritativeNativeReviewStore(repository);
    await readVerifiedCiReviewSources(repository);
    const counter = await installBodyReadCounter();

    try {
      // When
      const sources = await readVerifiedCiReviewSources(repository);

      // Then
      expect(sources).toHaveLength(2);
      expect(counter.bytes()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it("rejects a serialized or repository-rebound source capability", async () => {
    // Given
    const repository = await createRepository();
    const otherRepository = await createRepository();
    const stored = envelope("capability", "2026-10-28T00:00:00.000Z");
    await writeRecord(repository, stored);
    const source = onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId));
    const serialized = structuredClone(source);

    // When / Then
    await expect(assertVerifiedCiReviewSourceCurrent(repository, serialized)).rejects.toThrow(/issued|capability/i);
    await expect(assertVerifiedCiReviewSourceCurrent(otherRepository, source)).rejects.toThrow(/repository|scope/i);
  });

  it.each([
    ["private root mode", async (repository: string) => chmod(join(repository, "dim-authoritative-reviews"), 0o750)],
    ["proposals symlink", async (repository: string) => {
      const proposals = join(repository, "dim-authoritative-reviews", "proposals");
      const retained = join(repository, "dim-authoritative-reviews", "proposals-retained");
      await rename(proposals, retained);
      await symlink(retained, proposals);
    }]
  ] as const)("rejects proof reuse after a %s change", async (_change, mutateParent) => {
    // Given
    const repository = await createRepository();
    const stored = envelope(`parent-${_change.replaceAll(" ", "-")}`, "2026-10-28T00:00:00.000Z");
    await writeRecord(repository, stored);
    const source = onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId));
    await mutateParent(repository);

    // When / Then
    await expect(assertVerifiedCiReviewSourceCurrent(repository, source)).rejects.toThrow(/directory|private/i);
  });

  it.each([
    ["mutated", async (path: string) => appendFile(path, "\n", "utf8")],
    ["replaced", async (path: string) => {
      const replacement = `${path}.replacement`;
      await writeFile(replacement, await readFile(path), { mode: 0o600 });
      await rename(replacement, path);
    }],
    ["hard-linked", async (path: string) => link(path, `${path}.link`)],
    ["linked", async (path: string) => {
      const retained = `${path}.retained`;
      await rename(path, retained);
      await symlink(retained, path);
    }],
    ["chmodded", async (path: string) => chmod(path, 0o640)],
    ["deleted", async (path: string) => unlink(path)]
  ] as const)("rejects a %s attested record on every use", async (_effect, mutate) => {
    // Given
    const repository = await createRepository();
    const stored = envelope(`effect-${_effect}`, "2026-10-28T00:00:00.000Z");
    const path = await writeRecord(repository, stored);
    const source = onlySource(await readVerifiedCiReviewSources(repository, stored.review.reviewId));
    await mutate(path);

    // When / Then
    await expect(assertVerifiedCiReviewSourceCurrent(repository, source)).rejects.toThrow();
  });

  it("rejects malformed exact fallback records without inspecting unrelated history", async () => {
    // Given
    const repository = await createRepository();
    const selected = envelope("malformed", "2026-10-28T00:00:00.000Z");
    const unrelated = envelope("unrelated", "2026-10-28T00:00:01.000Z");
    await writeRecord(repository, selected, "{");
    const unrelatedPath = await writeRecord(repository, unrelated);
    const unrelatedBytes = await readFile(unrelatedPath);

    // When / Then
    await expect(readVerifiedCiReviewSources(repository, selected.review.reviewId)).rejects.toThrow();
    await expect(readFile(unrelatedPath)).resolves.toEqual(unrelatedBytes);
  });

  it("serializes source reads behind the immutable publication link window", async () => {
    // Given
    const repository = await createRepository();
    const stored = envelope("publication", "2026-10-28T00:00:00.000Z");
    const linked = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(storage, "publishReviewRecord").mockImplementation(async (publication) => {
      const staged = join(publication.stagingRoot, `${randomUUID()}.tmp`);
      await writeFile(staged, publication.serialized, { mode: 0o600 });
      await link(staged, publication.path);
      linked.resolve();
      await release.promise;
      await unlink(staged);
    });
    const saving = saveAuthoritativeNativeReviewEnvelope(repository, stored);
    await linked.promise;
    const path = recordPath(repository, stored);
    expect((await lstat(path)).nlink).toBe(2);

    // When
    const reading = readVerifiedCiReviewSources(repository, stored.review.reviewId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();

    // Then
    await expect(saving).resolves.toEqual(stored);
    await expect(reading).resolves.toHaveLength(1);
    expect((await lstat(path)).nlink).toBe(1);
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "dim-verified-review-"));
  roots.push(repository);
  await mkdir(join(repository, "dim-authoritative-reviews", "proposals"), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, "dim-authoritative-reviews", "staging"), { mode: 0o700 });
  return repository;
}

async function writeRecord(
  repository: string,
  stored: AuthoritativeNativeReviewEnvelope,
  serialized = `${JSON.stringify(stored)}\n`
): Promise<string> {
  const path = join(repository, "dim-authoritative-reviews", "proposals",
    `${stored.review.reviewId}.${stored.envelopeId}.json`);
  await writeFile(path, serialized, { mode: 0o600 });
  return path;
}

function recordPath(repository: string, stored: AuthoritativeNativeReviewEnvelope): string {
  return join(repository, "dim-authoritative-reviews", "proposals",
    `${stored.review.reviewId}.${stored.envelopeId}.json`);
}

function envelope(name: string, createdAt: string): AuthoritativeNativeReviewEnvelope {
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  return createAuthoritativeNativeReviewEnvelope({
    identity: {
      schemaVersion: 2, serviceId: "native-main", projectId: "project", repositoryId: "main",
      inputs: { main: snapshot },
      protectedRef: "refs/heads/main", proposalRef: `refs/heads/${name}`,
      expectedProtectedHead: "1".repeat(40), candidateCommit: snapshot.commit, candidateTree: snapshot.tree,
      policyRevision: "4".repeat(64), requiredReviewRevision: "5".repeat(64), requiredReviewerIds: [],
      changes: [{ status: "modified", oldPath: "README.md", newPath: "README.md", oldPathBytes: "UkVBRE1FLm1k",
        newPathBytes: "UkVBRE1FLm1k", oldMode: "100644", newMode: "100644", oldObjectId: "7".repeat(40), newObjectId: "8".repeat(40) }],
      patch: "large patch payload",
      patchBytes: Buffer.from("large patch payload").toString("base64")
    },
    policyDigest: "6".repeat(64),
    attachments: [{ kind: "git-ci", id: "plan", digest: "9".repeat(64) }],
    createdAt
  });
}

function compactReview(stored: AuthoritativeNativeReviewEnvelope): Omit<AuthoritativeNativeReviewEnvelope["review"], "changes" | "patch" | "patchBytes"> {
  const { changes: _changes, patch: _patch, patchBytes: _patchBytes, ...review } = stored.review;
  return review;
}

function onlySource<Result>(values: readonly Result[]): Result {
  const value = values[0];
  if (values.length !== 1 || value === undefined) throw new Error("expected exactly one verified review source");
  return value;
}

function deferred<Result>(): { readonly promise: Promise<Result>; readonly resolve: (value: Result) => void } {
  let resolve: ((value: Result) => void) | undefined;
  const promise = new Promise<Result>((complete) => { resolve = complete; });
  if (resolve === undefined) throw new Error("deferred promise did not initialize");
  return { promise, resolve };
}
