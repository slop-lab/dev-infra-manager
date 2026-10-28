import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readNativeHistoryCorpus, type NativeHistoryCorpusDescriptor } from "./native-history-corpus.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-history-fingerprint-"));
  const repository = join(root, "repository");
  const reviews = join(repository, "dim-authoritative-reviews", "proposals"), plans = join(repository, "dim-git-ci-plans");
  await mkdir(reviews, { recursive: true, mode: 0o700 });
  await mkdir(plans, { mode: 0o700 });
  const hash = createHash("sha256").update("dim-native-history-corpus-v1\0");
  let historyBytes = 0, planBytes = 0, largestReviewBytes = 0;
  for (let index = 0; index < 140; index += 1) {
    const id = index.toString(16).padStart(64, "0"), planId = (index + 200).toString(16).padStart(64, "0");
    if (index < 79) {
      const plan = `${JSON.stringify({ planning: { jobs: [{}] } })}\n`;
      await writeFile(join(plans, `${planId}.json`), plan, { mode: 0o600 });
      planBytes += Buffer.byteLength(plan);
      hash.update(`plan/${planId}.json`).update("\0").update(plan);
    }
    const review = `${JSON.stringify({ review: { reviewId: id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() },
      attachments: index < 79 ? [{ kind: "git-ci", id: planId }] : [], payload: "original" })}\n`;
    await writeFile(join(reviews, `${id}.json`), review, { mode: 0o600 });
    historyBytes += Buffer.byteLength(review);
    largestReviewBytes = Math.max(largestReviewBytes, Buffer.byteLength(review));
    hash.update(`review/${id}.json`).update("\0").update(review);
  }
  const descriptor: NativeHistoryCorpusDescriptor = { schemaVersion: 1, synthetic: true,
    purpose: "native-history-storage-cpu-fixture-not-git-promotion-proof", repositoryPath: "repository",
    reviewRecordCount: 140, projectionCount: 79, jobCount: 79, historyBytes, planBytes, largestReviewBytes,
    activeReviewId: "0".repeat(64), corpusFingerprint: `sha256:${hash.digest("hex")}` };
  await writeFile(join(root, "native-history-corpus.json"), JSON.stringify(descriptor), { mode: 0o600 });
  return { root, reviews, descriptor };
}

test("verifies the actual corpus bytes, counts and sizes before comparison", async () => {
  const selected = await fixture();
  try { assert.deepEqual((await readNativeHistoryCorpus(selected.root)).descriptor, selected.descriptor); }
  finally { await rm(selected.root, { recursive: true, force: true }); }
});

test("rejects a same-length corpus mutation despite an unchanged recorded fingerprint", async () => {
  const selected = await fixture();
  try {
    const id = "0".repeat(64), planId = (200).toString(16).padStart(64, "0");
    const changed = `${JSON.stringify({ review: { reviewId: id, createdAt: "2026-01-01T00:00:00.000Z" },
      attachments: [{ kind: "git-ci", id: planId }], payload: "modified" })}\n`;
    await writeFile(join(selected.reviews, `${id}.json`), changed);
    await assert.rejects(readNativeHistoryCorpus(selected.root), /no longer matches/);
  } finally { await rm(selected.root, { recursive: true, force: true }); }
});
