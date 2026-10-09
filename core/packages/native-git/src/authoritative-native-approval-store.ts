import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAuthoritativeNativeApproval,
  parseAuthoritativeNativeApproval,
  type AuthoritativeNativeApproval
} from "./authoritative-native-approval-schema.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging
} from "./review-record-storage.js";

const maximumRecordBytes = 16 * 1024;
const maximumApprovals = 100_000;
const recordPattern = /^([0-9a-f]{64})\.json$/;

export type AuthoritativeNativeApprovalRequest = {
  readonly repository: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly requestId: string;
};

export async function saveAuthoritativeNativeApproval(
  request: AuthoritativeNativeApprovalRequest
): Promise<{ readonly approval: AuthoritativeNativeApproval; readonly created: boolean }> {
  const paths = storePaths(request.repository);
  await initializeStore(paths);
  const approvals = await readStore(request.repository, paths);
  const existing = approvals.find((approval) => approval.reviewId === request.reviewId
    && approval.reviewerId === request.reviewerId && approval.requestId === request.requestId);
  if (existing !== undefined) {
    return { approval: existing, created: false };
  }
  if (approvals.length >= maximumApprovals) {
    throw new AuthoritativeNativeApprovalStoreError("authoritative native approval capacity is exhausted");
  }
  const approval = createAuthoritativeNativeApproval({
    reviewId: request.reviewId,
    reviewerId: request.reviewerId,
    requestId: request.requestId
  }, new Date().toISOString());
  const path = join(paths.records, `${approval.approvalId}.json`);
  try {
    await publishReviewRecord({
      path,
      serialized: `${JSON.stringify(approval)}\n`,
      stagingRoot: paths.staging,
      faults: {}
    });
    return { approval, created: true };
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const published = parseAuthoritativeNativeApproval(await readReviewJson(path, maximumRecordBytes, true));
    if (JSON.stringify(published) !== JSON.stringify(approval)) {
      throw new AuthoritativeNativeApprovalConflictError("approval identity conflicts with durable evidence");
    }
    return { approval: published, created: false };
  }
}

export async function readAuthoritativeNativeApprovals(
  repository: string,
  reviewId?: string
): Promise<readonly AuthoritativeNativeApproval[]> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  await assertAuthoritativeNativeApprovalStore(repository);
  const approvals = await readStore(repository, paths);
  return reviewId === undefined ? approvals : approvals.filter((approval) => approval.reviewId === reviewId);
}

export async function assertAuthoritativeNativeApprovalStore(repository: string): Promise<void> {
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
    throw new AuthoritativeNativeApprovalStoreError("authoritative native approval store layout is invalid");
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
    throw new AuthoritativeNativeApprovalStoreError("authoritative native approval directory is not private");
  }
}

async function readStore(repository: string, paths: StorePaths): Promise<readonly AuthoritativeNativeApproval[]> {
  const approvals: AuthoritativeNativeApproval[] = [];
  const entries = (await readdir(paths.records, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > maximumApprovals) {
    throw new AuthoritativeNativeApprovalStoreError("authoritative native approval capacity is exceeded");
  }
  for (const entry of entries) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeApprovalStoreError("authoritative native approval record name is invalid");
    }
    const approval = parseAuthoritativeNativeApproval(
      await readReviewJson(join(paths.records, entry.name), maximumRecordBytes, true)
    );
    if (match[1] !== approval.approvalId) {
      throw new AuthoritativeNativeApprovalStoreError("authoritative native approval path conflicts with its identity");
    }
    const review = await readAuthoritativeNativeReviewEnvelope(repository, approval.reviewId);
    if (review === undefined || !review.review.requiredReviewerIds.includes(approval.reviewerId)) {
      throw new AuthoritativeNativeApprovalStoreError("authoritative native approval has no required stored review");
    }
    approvals.push(approval);
  }
  return approvals;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new AuthoritativeNativeApprovalStoreError("native Git approval requires a Linux identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AuthoritativeNativeApprovalStoreError extends Error {
  readonly name = "AuthoritativeNativeApprovalStoreError";
}

export class AuthoritativeNativeApprovalConflictError extends Error {
  readonly name = "AuthoritativeNativeApprovalConflictError";
}
