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

const maximumRecordBytes = 128 * 1024 * 1024;
const maximumEvents = 100_000;
const recordPattern = /^([0-9a-f]{64})\.json$/;

export async function saveAuthoritativeNativeReviewEnvelope(
  repository: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<AuthoritativeNativeReviewEnvelope> {
  const paths = storePaths(repository);
  await initializeStore(paths);
  const envelopes = await readStore(paths);
  const existing = envelopes.find(({ review }) => review.reviewId === envelope.review.reviewId);
  if (existing !== undefined) return existing;
  if (envelopes.reduce((count, current) => count + current.events.length, 0) + envelope.events.length > maximumEvents) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review event capacity is exhausted");
  }
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review envelope exceeds the storage bound");
  }
  const path = join(paths.proposals, `${envelope.review.reviewId}.json`);
  try {
    await publishReviewRecord({ path, serialized, stagingRoot: paths.staging, faults: {} });
    return envelope;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    return parseAuthoritativeNativeReviewEnvelope(await readReviewJson(path, maximumRecordBytes));
  }
}

export async function readAuthoritativeNativeReviewEnvelope(
  repository: string,
  reviewId: string
): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  if (!/^[0-9a-f]{64}$/.test(reviewId)) return undefined;
  const paths = storePaths(repository);
  await assertAuthoritativeNativeReviewStore(repository);
  try {
    return parseAuthoritativeNativeReviewEnvelope(
      await readReviewJson(join(paths.proposals, `${reviewId}.json`), maximumRecordBytes)
    );
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
  await assertOwnedReviewDirectory(paths.root);
  const entries = await readdir(paths.root, { withFileTypes: true });
  if (entries.length !== 2 || entries.some((entry) => !entry.isDirectory()
    || (entry.name !== "proposals" && entry.name !== "staging"))) {
    throw new AuthoritativeNativeReviewStoreError("authoritative native review store layout is invalid");
  }
  await assertOwnedReviewDirectory(paths.proposals);
  await assertOwnedReviewDirectory(paths.staging);
  await Promise.all([paths.root, paths.proposals, paths.staging].map(assertPrivateStoreDirectory));
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.proposals });
  await readStore(paths);
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
  const eventIds = new Set<string>();
  let eventCount = 0;
  for (const entry of (await readdir(paths.proposals, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const match = recordPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review record name is invalid");
    }
    const envelope = parseAuthoritativeNativeReviewEnvelope(
      await readReviewJson(join(paths.proposals, entry.name), maximumRecordBytes)
    );
    if (match[1] !== envelope.review.reviewId) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review path conflicts with its identity");
    }
    for (const event of envelope.events) {
      if (eventIds.has(event.eventId)) {
        throw new AuthoritativeNativeReviewStoreError("authoritative native review event identity is duplicated");
      }
      eventIds.add(event.eventId);
    }
    eventCount += envelope.events.length;
    if (eventCount > maximumEvents) {
      throw new AuthoritativeNativeReviewStoreError("authoritative native review event capacity is exceeded");
    }
    envelopes.push(envelope);
  }
  return envelopes;
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
