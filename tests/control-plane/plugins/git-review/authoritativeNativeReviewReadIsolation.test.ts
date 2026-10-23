import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAuthoritativeNativeReviewStore,
  readAuthoritativeNativeReviewEnvelope
} from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";
import {
  createBundleReview,
  nativeBundleReviewFixture
} from "./reviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative native review named-read isolation", () => {
  it("reads only the selected review without recovering or parsing unrelated state while startup rejects it", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("authoritative-review-read-isolation");
    const selected = await createBundleReview(fixture.service);
    await closeFinalizeService(fixture.service);
    const repository = rootRepository(fixture.root);
    const root = join(repository, "dim-authoritative-reviews");
    const selectedPath = join(root, "proposals", `${selected.review.reviewId}.${selected.envelopeId}.json`);
    const unrelatedId = selected.review.reviewId === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const unrelatedPath = join(root, "proposals", `${unrelatedId}.json`);
    const stagingPath = join(root, "staging", `${unrelatedId}.json.${randomUUID()}.tmp`);
    const malformed = Buffer.alloc(1024 * 1024, "{");
    await writeFile(unrelatedPath, malformed, { mode: 0o600 });
    await link(unrelatedPath, stagingPath);
    const before = {
      selectedBytes: await readFile(selectedPath),
      unrelatedBytes: await readFile(unrelatedPath),
      unrelated: await lstat(unrelatedPath),
      staging: await lstat(stagingPath)
    };

    // When
    const read = await readAuthoritativeNativeReviewEnvelope(repository, selected.review.reviewId);

    // Then
    expect(read).toEqual(selected);
    expect(await readFile(selectedPath)).toEqual(before.selectedBytes);
    expect(await readFile(unrelatedPath)).toEqual(before.unrelatedBytes);
    expect(fileIdentity(await lstat(unrelatedPath))).toEqual(fileIdentity(before.unrelated));
    expect(fileIdentity(await lstat(stagingPath))).toEqual(fileIdentity(before.staging));
    await expect(assertAuthoritativeNativeReviewStore(repository)).rejects.toThrow();
    expect(await readFile(unrelatedPath)).toEqual(before.unrelatedBytes);
  }, 30_000);

  it("fails closed when the selected review is malformed", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("authoritative-review-selected-malformed");
    const selected = await createBundleReview(fixture.service);
    await closeFinalizeService(fixture.service);
    const repository = rootRepository(fixture.root);
    const path = selectedReviewPath(repository, selected.review.reviewId, selected.envelopeId);
    await writeFile(path, "{", "utf8");

    // When / Then
    await expect(readAuthoritativeNativeReviewEnvelope(repository, selected.review.reviewId)).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe("{");
  }, 30_000);

  it.each([
    ["directory", async (repository: string, _path: string) => chmod(join(repository,
      "dim-authoritative-reviews", "proposals"), 0o750)],
    ["file", async (_repository: string, path: string) => chmod(path, 0o640)]
  ] as const)("fails closed for an unsafe selected-review %s without changing its bytes", async (_kind, makeUnsafe) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`authoritative-review-unsafe-${_kind}`);
    const selected = await createBundleReview(fixture.service);
    await closeFinalizeService(fixture.service);
    const repository = rootRepository(fixture.root);
    const path = selectedReviewPath(repository, selected.review.reviewId, selected.envelopeId);
    const bytes = await readFile(path);
    await makeUnsafe(repository, path);

    // When / Then
    await expect(readAuthoritativeNativeReviewEnvelope(repository, selected.review.reviewId)).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
  }, 30_000);
});

function selectedReviewPath(repository: string, reviewId: string, envelopeId: string): string {
  return join(repository, "dim-authoritative-reviews", "proposals", `${reviewId}.${envelopeId}.json`);
}

function fileIdentity(metadata: Stats) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
    nlink: metadata.nlink,
    size: metadata.size
  };
}
