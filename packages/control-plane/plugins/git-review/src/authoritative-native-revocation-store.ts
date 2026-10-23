import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAuthoritativeNativeRevocation,
  parseAuthoritativeNativeRevocation,
  type AuthoritativeNativeRevocation
} from "./authoritative-native-revocation-schema.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging
} from "./review-record-storage.js";

const maximumRecordBytes = 16 * 1024;
const maximumRevocations = 100_000;
const recordPattern = /^([0-9a-f]{64})\.json$/;

type RevocationRequest = {
  readonly repository: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly approvalId: string;
};

export async function saveAuthoritativeNativeRevocation(
  request: RevocationRequest
): Promise<{ readonly revocation: AuthoritativeNativeRevocation; readonly created: boolean }> {
  const paths = storePaths(request.repository);
  await initializeStore(paths);
  const revocations = await readStore(paths);
  const existing = revocations.find((candidate) => candidate.approvalId === request.approvalId);
  if (existing !== undefined) {
    if (existing.reviewId !== request.reviewId || existing.reviewerId !== request.reviewerId) {
      throw new AuthoritativeNativeRevocationStoreError("revocation identity conflicts with durable evidence");
    }
    return { revocation: existing, created: false };
  }
  if (revocations.length >= maximumRevocations) {
    throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation capacity is exhausted");
  }
  const revocation = createAuthoritativeNativeRevocation({
    reviewId: request.reviewId,
    reviewerId: request.reviewerId,
    approvalId: request.approvalId
  }, new Date().toISOString());
  const path = join(paths.records, `${revocation.revocationId}.json`);
  try {
    await publishReviewRecord({ path, serialized: `${JSON.stringify(revocation)}\n`, stagingRoot: paths.staging,
      faults: {} });
    return { revocation, created: true };
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const published = parseAuthoritativeNativeRevocation(await readReviewJson(path, maximumRecordBytes, true));
    if (JSON.stringify(published) !== JSON.stringify(revocation)) {
      throw new AuthoritativeNativeRevocationStoreError("revocation identity conflicts with durable evidence");
    }
    return { revocation: published, created: false };
  }
}

export async function readAuthoritativeNativeRevocations(
  repository: string
): Promise<readonly AuthoritativeNativeRevocation[]> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  await assertAuthoritativeNativeRevocationStore(repository);
  return readStore(paths);
}

export async function assertAuthoritativeNativeRevocationStore(repository: string): Promise<void> {
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
    throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation store layout is invalid");
  }
  await assertOwnedReviewDirectory(paths.records);
  await assertOwnedReviewDirectory(paths.staging);
  await Promise.all([paths.root, paths.records, paths.staging].map(assertPrivateDirectory));
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.records });
  await readStore(paths);
}

type StorePaths = { readonly root: string; readonly records: string; readonly staging: string };

function storePaths(repository: string): StorePaths {
  const root = join(repository, "dim-authoritative-revocations");
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
    throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation directory is not private");
  }
}

async function readStore(paths: StorePaths): Promise<readonly AuthoritativeNativeRevocation[]> {
  const revocations: AuthoritativeNativeRevocation[] = [];
  const approvalIds = new Set<string>();
  const entries = (await readdir(paths.records, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > maximumRevocations) {
    throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation capacity is exceeded");
  }
  for (const entry of entries) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation record name is invalid");
    }
    const revocation = parseAuthoritativeNativeRevocation(
      await readReviewJson(join(paths.records, entry.name), maximumRecordBytes, true)
    );
    if (match[1] !== revocation.revocationId) {
      throw new AuthoritativeNativeRevocationStoreError("authoritative native revocation path conflicts with its identity");
    }
    if (approvalIds.has(revocation.approvalId)) {
      throw new AuthoritativeNativeRevocationStoreError("authoritative native approval revocation is duplicated");
    }
    approvalIds.add(revocation.approvalId);
    revocations.push(revocation);
  }
  return revocations;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new AuthoritativeNativeRevocationStoreError("native Git revocation requires a Linux identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AuthoritativeNativeRevocationStoreError extends Error {
  readonly name = "AuthoritativeNativeRevocationStoreError";
}
