import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createReviewApproval,
  parseReviewApproval,
  type ReviewApproval,
} from "@slop-lab/gs-review-contracts";
import { readReviewEnvelope } from "./review-store.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging,
} from "./review-record-storage.js";

const maximumRecordBytes = 16 * 1024;
const maximumApprovals = 100_000;
const recordPattern = /^([0-9a-f]{64})\.json$/;

export type ReviewApprovalRequest = {
  readonly repository: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly requestId: string;
};

export async function saveReviewApproval(
  request: ReviewApprovalRequest,
): Promise<{ readonly approval: ReviewApproval; readonly created: boolean }> {
  const paths = storePaths(request.repository);
  await initializeStore(paths);
  const approvals = await readStore(request.repository, paths);
  const existing = approvals.find((approval) => approval.reviewId === request.reviewId
    && approval.reviewerId === request.reviewerId && approval.requestId === request.requestId);
  if (existing !== undefined) return { approval: existing, created: false };
  if (approvals.length >= maximumApprovals) {
    throw new ReviewApprovalStoreError("review approval capacity is exhausted");
  }
  const approval = createReviewApproval({
    reviewId: request.reviewId,
    reviewerId: request.reviewerId,
    requestId: request.requestId,
  }, new Date().toISOString());
  const path = join(paths.records, `${approval.approvalId}.json`);
  try {
    await publishReviewRecord({
      path,
      serialized: `${JSON.stringify(approval)}\n`,
      stagingRoot: paths.staging,
      faults: {},
    });
    return { approval, created: true };
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const published = parseReviewApproval(await readReviewJson(path, maximumRecordBytes, true));
    if (JSON.stringify(published) !== JSON.stringify(approval)) {
      throw new ReviewApprovalConflictError("approval identity conflicts with durable evidence");
    }
    return { approval: published, created: false };
  }
}

export async function readReviewApprovals(
  repository: string,
  reviewId?: string,
): Promise<readonly ReviewApproval[]> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  await assertReviewApprovalStore(repository);
  const approvals = await readStore(repository, paths);
  return reviewId === undefined ? approvals : approvals.filter((approval) => approval.reviewId === reviewId);
}

export async function assertReviewApprovalStore(repository: string): Promise<void> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  await assertOwnedReviewDirectory(paths.root);
  const entries = await readdir(paths.root, { withFileTypes: true });
  if (entries.length !== 2 || entries.some((entry) => !entry.isDirectory()
    || (entry.name !== "records" && entry.name !== "staging"))) {
    throw new ReviewApprovalStoreError("review approval store layout is invalid");
  }
  await assertOwnedReviewDirectory(paths.records);
  await assertOwnedReviewDirectory(paths.staging);
  await Promise.all([paths.root, paths.records, paths.staging].map(assertPrivateDirectory));
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.records });
  await readStore(repository, paths);
}

type StorePaths = { readonly root: string; readonly records: string; readonly staging: string };

function storePaths(repository: string): StorePaths {
  const root = join(repository, "dim-authoritative-approvals");
  return { root, records: join(root, "records"), staging: join(root, "staging") };
}

async function initializeStore(paths: StorePaths): Promise<void> {
  await ownedReviewDirectory(paths.root);
  await ownedReviewDirectory(paths.records);
  await ownedReviewDirectory(paths.staging);
  await Promise.all([paths.root, paths.records, paths.staging].map(assertPrivateDirectory));
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new ReviewApprovalStoreError("review approval directory is not private");
  }
}

async function readStore(repository: string, paths: StorePaths): Promise<readonly ReviewApproval[]> {
  const approvals: ReviewApproval[] = [];
  const entries = (await readdir(paths.records, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > maximumApprovals) {
    throw new ReviewApprovalStoreError("review approval capacity is exceeded");
  }
  for (const entry of entries) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new ReviewApprovalStoreError("review approval record name is invalid");
    }
    const approval = parseReviewApproval(
      await readReviewJson(join(paths.records, entry.name), maximumRecordBytes, true),
    );
    if (match[1] !== approval.approvalId) {
      throw new ReviewApprovalStoreError("review approval path conflicts with its identity");
    }
    const review = await readReviewEnvelope(repository, approval.reviewId);
    if (review === undefined || !review.review.requiredReviewerIds.includes(approval.reviewerId)) {
      throw new ReviewApprovalStoreError("review approval has no required stored review");
    }
    approvals.push(approval);
  }
  return approvals;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ReviewApprovalStoreError("Git approval requires a Linux identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewApprovalStoreError extends Error {
  readonly name = "ReviewApprovalStoreError";
}

export class ReviewApprovalConflictError extends Error {
  readonly name = "ReviewApprovalConflictError";
}
