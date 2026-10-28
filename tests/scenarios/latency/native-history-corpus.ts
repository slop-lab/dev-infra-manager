import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { deterministicPatch, reviewPayloadBytes } from "./native-history-metrics.js";

const descriptorName = "native-history-corpus.json";
const repositoryName = "repository";
const descriptorSchema = z.object({
  schemaVersion: z.literal(1),
  synthetic: z.literal(true),
  purpose: z.literal("native-history-storage-cpu-fixture-not-git-promotion-proof"),
  repositoryPath: z.literal(repositoryName),
  reviewRecordCount: z.literal(140),
  projectionCount: z.literal(79),
  jobCount: z.literal(79),
  historyBytes: z.number().int().positive(),
  planBytes: z.number().int().positive(),
  largestReviewBytes: z.number().int().positive(),
  corpusFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  activeReviewId: z.string().regex(/^[0-9a-f]{64}$/)
}).strict().readonly();

export type NativeHistoryCorpusDescriptor = z.infer<typeof descriptorSchema>;

type ReviewSchemaModule = typeof import("../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js");
type ReviewStoreModule = typeof import("../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js");
type PlanStoreModule = typeof import("../../../packages/control-plane/plugins/git-ci/src/plan-store.js");
type GitCiPlan = import("../../../packages/control-plane/plugins/git-ci/src/plan-store.js").GitCiPlan;

export async function prepareNativeHistoryCorpus(
  sourceTree: string,
  corpusDirectory: string
): Promise<NativeHistoryCorpusDescriptor> {
  const target = resolve(corpusDirectory);
  await mkdir(target, { recursive: false, mode: 0o700 });
  try {
    return await populateNativeHistoryCorpus(sourceTree, target);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function populateNativeHistoryCorpus(
  sourceTree: string,
  target: string
): Promise<NativeHistoryCorpusDescriptor> {
  await chmod(target, 0o700);
  const repository = join(target, repositoryName);
  await mkdir(repository, { mode: 0o700 });
  const reviewSchema: ReviewSchemaModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.ts");
  const reviewStore: ReviewStoreModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-review/src/authoritative-native-review-store.ts");
  const planStore: PlanStoreModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-ci/src/plan-store.ts");
  const fingerprint = createHash("sha256").update("dim-native-history-corpus-v1\0");
  let activeReviewId = "";
  for (const [index, payloadBytes] of reviewPayloadBytes().entries()) {
    const patchBytes = deterministicPatch(index, payloadBytes);
    const snapshot = { commit: objectId(`commit-${index}`), tree: objectId(`tree-${index}`) };
    const policyDigest = digest(`policy-${index}`);
    const plan = index < 79 ? gitCiPlan(index, snapshot, policyDigest) : undefined;
    const attachment = plan === undefined ? undefined : await planStore.saveGitCiPlan(repository, plan);
    if (attachment !== undefined) addFingerprint(fingerprint, `plan/${attachment.id}.json`, `${JSON.stringify(plan)}\n`);
    const workspaceId = Buffer.alloc(32, (index % 251) + 1).toString("base64url");
    const path = `synthetic/review-${String(index).padStart(3, "0")}.patch`;
    const identity = {
      schemaVersion: 2 as const,
      serviceId: "native-main" as const,
      projectId: "project-a",
      repositoryId: "root",
      inputs: { root: snapshot },
      protectedRef: "refs/heads/main",
      proposalRef: `refs/heads/proposals/${workspaceId}/synthetic-${index}`,
      expectedProtectedHead: objectId(`base-${index}`),
      candidateCommit: snapshot.commit,
      candidateTree: snapshot.tree,
      policyRevision: digest(`policy-revision-${index}`),
      requiredReviewRevision: digest(`review-revision-${index}`),
      workspaceId,
      requiredReviewerIds: ["owner"],
      changes: [{
        status: "modified" as const,
        oldPath: path,
        newPath: path,
        oldPathBytes: Buffer.from(path).toString("base64"),
        newPathBytes: Buffer.from(path).toString("base64"),
        oldMode: "100644",
        newMode: "100644",
        oldObjectId: objectId(`old-${index}`),
        newObjectId: objectId(`new-${index}`)
      }],
      patch: patchBytes.toString("ascii"),
      patchBytes: patchBytes.toString("base64")
    };
    const envelope = reviewSchema.createAuthoritativeNativeReviewEnvelope({
      identity,
      policyDigest,
      attachments: attachment === undefined ? [] : [attachment],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    });
    await reviewStore.saveAuthoritativeNativeReviewEnvelope(repository, envelope);
    const reviewName = `${envelope.review.reviewId}.${envelope.envelopeId}.json`;
    addFingerprint(fingerprint, `review/${reviewName}`, `${JSON.stringify(envelope)}\n`);
    if (index === 0) activeReviewId = envelope.review.reviewId;
  }
  const sizes = await corpusSizes(repository);
  const descriptor = descriptorSchema.parse({
    schemaVersion: 1,
    synthetic: true,
    purpose: "native-history-storage-cpu-fixture-not-git-promotion-proof",
    repositoryPath: repositoryName,
    reviewRecordCount: 140,
    projectionCount: 79,
    jobCount: 79,
    ...sizes,
    corpusFingerprint: `sha256:${fingerprint.digest("hex")}`,
    activeReviewId
  });
  await writeFile(join(target, descriptorName), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return descriptor;
}

export async function readNativeHistoryCorpus(corpusDirectory: string): Promise<{
  readonly descriptor: NativeHistoryCorpusDescriptor;
  readonly repository: string;
}> {
  const target = resolve(corpusDirectory);
  await assertPrivateCorpusDirectory(target);
  const file = await open(join(target, descriptorName), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > 64 * 1024) {
      throw new NativeHistoryCorpusError("native history descriptor must be a bounded private owned file");
    }
    const descriptor = descriptorSchema.parse(JSON.parse(await file.readFile("utf8")));
    const repository = join(target, descriptor.repositoryPath);
    await assertPrivateCorpusDirectory(repository);
    return { descriptor, repository };
  } finally {
    await file.close();
  }
}

async function assertPrivateCorpusDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()
    || (metadata.mode & 0o777) !== 0o700) throw new NativeHistoryCorpusError("native history corpus must be an owned private directory");
}

async function corpusSizes(repository: string): Promise<{
  readonly historyBytes: number;
  readonly planBytes: number;
  readonly largestReviewBytes: number;
}> {
  const reviewRoot = join(repository, "dim-authoritative-reviews", "proposals");
  const planRoot = join(repository, "dim-git-ci-plans");
  const reviewSizes = await fileSizes(reviewRoot);
  const planSizes = await fileSizes(planRoot);
  return {
    historyBytes: reviewSizes.reduce((total, bytes) => total + bytes, 0),
    planBytes: planSizes.reduce((total, bytes) => total + bytes, 0),
    largestReviewBytes: Math.max(...reviewSizes)
  };
}

function gitCiPlan(index: number, snapshot: { readonly commit: string; readonly tree: string }, policyDigest: string): GitCiPlan {
  const job = { executionKind: "ordinary-sysbox" as const, jobName: "source", evidenceClass: "candidate-controlled" as const };
  return {
    schemaVersion: 1,
    projectId: "project-a",
    repositoryId: "root",
    expectedProtectedHead: objectId(`base-${index}`),
    candidateCommit: snapshot.commit,
    candidateTree: snapshot.tree,
    policyDigest,
    qualityRevision: digest(`quality-${index}`),
    requiredJobs: [job],
    planning: { status: "valid", configBlob: null, jobs: [{ ...job,
      script: { objectId: objectId(`script-${index}`), sha256: `sha256:${digest(`script-bytes-${index}`)}`, path: ".dim/ci/jobs/source.bash" },
      argv: ["/bin/bash"], inputs: { root: snapshot }
    }] }
  };
}

async function fileSizes(directory: string): Promise<readonly number[]> {
  const names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => (await stat(join(directory, name))).size));
}

async function sourceImport<Module>(sourceTree: string, path: string): Promise<Module> {
  return import(pathToFileURL(resolve(sourceTree, path)).href);
}

function objectId(label: string): string { return digest(label).slice(0, 40); }
function digest(label: string): string { return createHash("sha256").update(label).digest("hex"); }
function addFingerprint(hash: ReturnType<typeof createHash>, path: string, serialized: string): void {
  hash.update(path).update("\0").update(serialized);
}
export class NativeHistoryCorpusError extends Error {
  readonly name = "NativeHistoryCorpusError";
}
