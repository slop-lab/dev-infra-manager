import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope
} from "./authoritative-native-review-schema.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging
} from "./review-record-storage.js";

export const maximumRecordBytes = 128 * 1024 * 1024;
const maximumRecords = 100_000;
const recordPattern = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/;

export async function saveAuthoritativeNativeReviewEnvelope(
  repository: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<AuthoritativeNativeReviewEnvelope> {
  envelope = parseAuthoritativeNativeReviewEnvelope(envelope);
  const paths = storePaths(repository);
  await initializeStore(paths);
  await assertStoreLayout(paths);
  const names = await readRecordNames(paths);
  const name = `${envelope.review.reviewId}.${envelope.envelopeId}.json`;
  if (names.includes(name)) return readEnvelope(paths, name);
  if (names.length >= maximumRecords) throw new AuthoritativeNativeReviewStoreError("authoritative native review record capacity is exhausted");
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review envelope exceeds the storage bound");
  }
  const path = join(paths.proposals, name);
  try {
    await publishReviewRecord({ path, serialized, stagingRoot: paths.staging, faults: {} });
    return envelope;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    return readEnvelope(paths, name);
  }
}

export async function readAuthoritativeNativeReviewEnvelope(
  repository: string,
  reviewId: string
): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  if (!/^[0-9a-f]{64}$/.test(reviewId)) return undefined;
  const paths = storePaths(repository);
  try {
    await Promise.all([paths.root, paths.proposals].map(assertPrivateStoreDirectory));
    await Promise.all([paths.root, paths.proposals].map(assertPrivateStoreDirectory));
    const names = (await readdir(paths.proposals, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${reviewId}.`))
      .map(({ name }) => name).sort();
    const envelopes = await Promise.all(names.map(async (name) => parseAuthoritativeNativeReviewEnvelope(
      await readReviewJson(join(paths.proposals, name), maximumRecordBytes)
    )));
    if (envelopes.some(({ review }) => review.reviewId !== reviewId)) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review path conflicts with its identity");
    }
    return envelopes.sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt))[0];
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function assertAuthoritativeNativeReviewStore(repository: string): Promise<void> {
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

async function assertStoreLayout(paths: StorePaths): Promise<void> {
  await assertOwnedReviewDirectory(paths.root);
  const entries = await readdir(paths.root, { withFileTypes: true });
  const allowed = new Set(["proposals", "staging"]);
  if (!entries.some(({ name }) => name === "proposals") || !entries.some(({ name }) => name === "staging")
    || entries.some((entry) => !entry.isDirectory() || !allowed.has(entry.name))) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review store layout is invalid");
  }
  await assertOwnedReviewDirectory(paths.proposals);
  await assertOwnedReviewDirectory(paths.staging);
  await Promise.all([paths.root, ...entries.map(({ name }) => join(paths.root, name))].map(assertPrivateStoreDirectory));
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.proposals });
}

export async function readAuthoritativeNativeReviewEnvelopes(
  repository: string
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
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

type StorePaths = {
  readonly root: string;
  readonly proposals: string;
  readonly staging: string;
};

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

async function assertPrivateStoreDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review directory is not private");
  }
}

async function readStore(paths: StorePaths): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const name of await readRecordNames(paths)) envelopes.push(await readEnvelope(paths, name));
  return envelopes;
}

/** Validate bounded, private canonical paths without loading historical patches. */
async function readRecordNames(paths: StorePaths): Promise<readonly string[]> {
  const names: string[] = [];
  for (const entry of (await readdir(paths.proposals, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review record name is invalid");
    }
    const metadata = await lstat(join(paths.proposals, entry.name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== serviceUid()
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > maximumRecordBytes) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review record is not a bounded private file");
    }
    if (names.length >= maximumRecords) throw new AuthoritativeNativeReviewStoreError("authoritative native review record capacity is exceeded");
    names.push(entry.name);
  }
  return names;
}

async function readEnvelope(paths: StorePaths, name: string): Promise<AuthoritativeNativeReviewEnvelope> {
  const match = recordPattern.exec(name);
  const envelope = parseAuthoritativeNativeReviewEnvelope(await readReviewJson(join(paths.proposals, name), maximumRecordBytes));
  if (match === null || match[1] !== envelope.review.reviewId || match[2] !== envelope.envelopeId) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review path conflicts with its identity");
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
