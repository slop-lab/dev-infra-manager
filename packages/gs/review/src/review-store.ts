import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope,
} from "@slop-lab/gs-review-contracts";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging,
} from "./review-record-storage.js";
import { readVersionedReviewRecord } from "./review-record-version.js";
import { runReviewStoreOperation } from "./review-store-queue.js";

export {
  assertVerifiedCiReviewSourceCurrent,
  readVerifiedCiReviewSources,
  type VerifiedCiReviewSource,
  type VerifiedCiReviewSummary,
} from "./verified-review-store.js";

export const maximumRecordBytes = 128 * 1024 * 1024;
const maximumRecords = 100_000;
const recordPattern = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/;

export async function saveAuthoritativeNativeReviewEnvelope(
  repository: string,
  envelope: AuthoritativeNativeReviewEnvelope,
): Promise<AuthoritativeNativeReviewEnvelope> {
  return runReviewStoreOperation(repository, () => saveEnvelope(repository, envelope));
}

async function saveEnvelope(
  repository: string,
  envelopeInput: AuthoritativeNativeReviewEnvelope,
): Promise<AuthoritativeNativeReviewEnvelope> {
  const envelope = parseAuthoritativeNativeReviewEnvelope(envelopeInput);
  const paths = storePaths(repository);
  await initializeStore(paths);
  await assertStoreLayout(paths);
  const names = await readRecordNames(paths);
  const name = `${envelope.review.reviewId}.${envelope.envelopeId}.json`;
  if (names.includes(name)) return readEnvelope(paths, name);
  if (names.length >= maximumRecords) throw new AuthoritativeNativeReviewStoreError("review record capacity is exhausted");
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) {
    throw new AuthoritativeNativeReviewStoreError("review envelope exceeds the storage bound");
  }
  try {
    await publishReviewRecord({ path: join(paths.proposals, name), serialized, stagingRoot: paths.staging, faults: {} });
    return envelope;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    return readEnvelope(paths, name);
  }
}

export async function readAuthoritativeNativeReviewEnvelope(
  repository: string,
  reviewId: string,
): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  return runReviewStoreOperation(repository, () => readSelectedEnvelope(repository, reviewId));
}

async function readSelectedEnvelope(
  repository: string,
  reviewId: string,
): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  if (!/^[0-9a-f]{64}$/.test(reviewId)) return undefined;
  const paths = storePaths(repository);
  try {
    await Promise.all([paths.root, paths.proposals].map(assertPrivateStoreDirectory));
    const names = (await readdir(paths.proposals, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${reviewId}.`))
      .map(({ name }) => name).sort();
    const envelopes = await Promise.all(names.map((name) => readEnvelope(paths, name)));
    if (envelopes.some(({ review }) => review.reviewId !== reviewId)) {
      throw new AuthoritativeNativeReviewStoreError("review path conflicts with its identity");
    }
    return envelopes.sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt))[0];
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function assertAuthoritativeNativeReviewStore(repository: string): Promise<void> {
  return runReviewStoreOperation(repository, () => assertStore(repository));
}

async function assertStore(repository: string): Promise<void> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  await assertStoreLayout(paths);
  await readStore(paths);
}

export async function readAuthoritativeNativeReviewEnvelopes(
  repository: string,
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  return runReviewStoreOperation(repository, () => readEnvelopes(repository));
}

async function readEnvelopes(repository: string): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const paths = storePaths(repository);
  try {
    await lstat(paths.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  await assertStoreLayout(paths);
  return readStore(paths);
}

type StorePaths = { readonly root: string; readonly proposals: string; readonly staging: string };

function storePaths(repository: string): StorePaths {
  const root = join(repository, "dim-authoritative-reviews");
  return { root, proposals: join(root, "proposals"), staging: join(root, "staging") };
}

async function initializeStore(paths: StorePaths): Promise<void> {
  await ownedReviewDirectory(paths.root);
  await ownedReviewDirectory(paths.proposals);
  await ownedReviewDirectory(paths.staging);
  await Promise.all([paths.root, paths.proposals, paths.staging].map(assertPrivateStoreDirectory));
}

async function assertStoreLayout(paths: StorePaths): Promise<void> {
  await assertOwnedReviewDirectory(paths.root);
  const entries = await readdir(paths.root, { withFileTypes: true });
  const allowed = new Set(["proposals", "staging"]);
  if (!entries.some(({ name }) => name === "proposals") || !entries.some(({ name }) => name === "staging")
    || entries.some((entry) => !entry.isDirectory() || !allowed.has(entry.name))) {
    throw new AuthoritativeNativeReviewStoreError("review store layout is invalid");
  }
  await assertOwnedReviewDirectory(paths.proposals);
  await assertOwnedReviewDirectory(paths.staging);
  await Promise.all([paths.root, ...entries.map(({ name }) => join(paths.root, name))].map(assertPrivateStoreDirectory));
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.proposals });
}

async function assertPrivateStoreDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new AuthoritativeNativeReviewStoreError("review directory is not private");
  }
}

async function readStore(paths: StorePaths): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const name of await readRecordNames(paths)) envelopes.push(await readEnvelope(paths, name));
  return envelopes;
}

async function readRecordNames(paths: StorePaths): Promise<readonly string[]> {
  const names: string[] = [];
  for (const entry of (await readdir(paths.proposals, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) throw new AuthoritativeNativeReviewStoreError("review record name is invalid");
    const metadata = await lstat(join(paths.proposals, entry.name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
      || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size > maximumRecordBytes) {
      throw new AuthoritativeNativeReviewStoreError("review record is not a bounded private file");
    }
    if (names.length >= maximumRecords) throw new AuthoritativeNativeReviewStoreError("review record capacity is exceeded");
    names.push(entry.name);
  }
  return names;
}

async function readEnvelope(paths: StorePaths, name: string): Promise<AuthoritativeNativeReviewEnvelope> {
  const match = recordPattern.exec(name);
  const record = await readVersionedReviewRecord(join(paths.proposals, name), maximumRecordBytes);
  const envelope = parseAuthoritativeNativeReviewEnvelope(record.value);
  if (match === null || match[1] !== envelope.review.reviewId || match[2] !== envelope.envelopeId) {
    throw new AuthoritativeNativeReviewStoreError("review path conflicts with its identity");
  }
  return envelope;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new AuthoritativeNativeReviewStoreError("native Git review requires a Linux identity");
  return uid;
}

export class AuthoritativeNativeReviewStoreError extends Error {
  readonly name = "AuthoritativeNativeReviewStoreError";
}
