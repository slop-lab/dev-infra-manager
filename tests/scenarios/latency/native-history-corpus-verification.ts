import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { NativeHistoryCorpusDescriptor } from "./native-history-corpus.js";

const reviewMetadata = z.object({
  review: z.object({ createdAt: z.string().datetime(), reviewId: z.string() }),
  attachments: z.array(z.object({ kind: z.string(), id: z.string().regex(/^[0-9a-f]{64}$/) }))
});

export async function verifyNativeHistoryCorpus(
  repository: string,
  descriptor: NativeHistoryCorpusDescriptor
): Promise<void> {
  const reviewRoot = join(repository, "dim-authoritative-reviews", "proposals");
  const planRoot = join(repository, "dim-git-ci-plans");
  const names = await recordNames(reviewRoot);
  const planNames = await recordNames(planRoot);
  if (names.length !== descriptor.reviewRecordCount || planNames.length !== descriptor.projectionCount) invalid();
  const records: { readonly name: string; readonly createdAt: string; readonly planIds: readonly string[] }[] = [];
  let historyBytes = 0, largestReviewBytes = 0;
  for (const name of names) {
    const bytes = await readPrivateCorpusRecord(join(reviewRoot, name));
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const metadata = reviewMetadata.parse(value);
    historyBytes += bytes.length;
    largestReviewBytes = Math.max(largestReviewBytes, bytes.length);
    records.push({ name, createdAt: metadata.review.createdAt,
      planIds: metadata.attachments.filter(({ kind }) => kind === "git-ci").map(({ id }) => id) });
  }
  const hash = createHash("sha256").update("dim-native-history-corpus-v1\0");
  let planBytes = 0, jobs = 0;
  const seenPlans = new Set<string>();
  for (const record of records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    for (const id of record.planIds) {
      if (seenPlans.has(id) || !planNames.includes(`${id}.json`)) invalid();
      seenPlans.add(id);
      const bytes = await readPrivateCorpusRecord(join(planRoot, `${id}.json`));
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      const plan = z.object({ planning: z.object({ jobs: z.array(z.unknown()) }) }).parse(value);
      jobs += plan.planning.jobs.length;
      planBytes += bytes.length;
      hash.update(`plan/${id}.json`).update("\0").update(bytes);
    }
    hash.update(`review/${record.name}`).update("\0").update(await readPrivateCorpusRecord(join(reviewRoot, record.name)));
  }
  if (historyBytes !== descriptor.historyBytes || largestReviewBytes !== descriptor.largestReviewBytes
    || planBytes !== descriptor.planBytes || jobs !== descriptor.jobCount
    || seenPlans.size !== descriptor.projectionCount
    || `sha256:${hash.digest("hex")}` !== descriptor.corpusFingerprint) invalid();
}

async function recordNames(directory: string): Promise<readonly string[]> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()
    || (metadata.mode & 0o777) !== 0o700) invalid();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !/^[0-9a-f.]+\.json$/.test(entry.name))) invalid();
  return entries.map(({ name }) => name).sort();
}

export async function readPrivateCorpusRecord(path: string, maximumBytes = 128 * 1024 * 1024): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.geteuid?.() ?? -1) || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n || before.size > BigInt(maximumBytes)) invalid();
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    for (const metadata of [after, current]) {
      if (metadata.dev !== before.dev || metadata.ino !== before.ino || metadata.size !== before.size
        || metadata.mtimeNs !== before.mtimeNs || metadata.ctimeNs !== before.ctimeNs
        || metadata.mode !== before.mode || metadata.uid !== before.uid || metadata.nlink !== before.nlink) invalid();
    }
    return bytes;
  } finally { await file.close(); }
}

function invalid(): never { throw new NativeHistoryCorpusVerificationError("native history corpus no longer matches its descriptor"); }
export class NativeHistoryCorpusVerificationError extends Error {
  readonly name = "NativeHistoryCorpusVerificationError";
}
