import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope
} from "./authoritative-native-review-schema.js";
import {
  inspectReviewRecordVersion,
  readVersionedReviewRecord,
  sameReviewRecordVersion,
  type VersionedReviewRecord
} from "./review-record-version.js";
import { recoverPublishedReviewStaging } from "./review-record-storage.js";
import { runReviewStoreOperation } from "./review-store-queue.js";
import {
  issuedVerifiedCiReviewSources,
  issueVerifiedCiReviewSource,
  verifiedCiReviewSourceProof,
  VerifiedCiReviewSourceError,
  type VerifiedCiReviewSource
} from "./verified-ci-review-source.js";

export type { VerifiedCiReviewSource, VerifiedCiReviewSummary } from "./verified-ci-review-source.js";

const maximumRecordBytes = 128 * 1024 * 1024;
const maximumRecords = 100_000;
const recordPattern = /^([0-9a-f]{64})\.([0-9a-f]{64})\.json$/;

export async function readVerifiedCiReviewSources(
  repository: string,
  reviewId?: string
): Promise<readonly VerifiedCiReviewSource[]> {
  return runReviewStoreOperation(repository, (repositoryKey) => readSources(repository, repositoryKey, reviewId));
}

export async function assertVerifiedCiReviewSourceCurrent(
  repository: string,
  source: VerifiedCiReviewSource
): Promise<void> {
  return runReviewStoreOperation(repository, (repositoryKey) => assertSourceCurrent(repositoryKey, source));
}

export type VerifiedCiReviewRecordAttestation = {
  readonly repositoryKey: string;
  readonly path: string;
  readonly recordName: string;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly record: VersionedReviewRecord;
};

export function attestVerifiedCiReviewRecord(
  attestation: VerifiedCiReviewRecordAttestation
): VerifiedCiReviewSource {
  return issueVerifiedCiReviewSource({
    repository: attestation.repositoryKey,
    path: attestation.path,
    recordName: attestation.recordName,
    envelope: attestation.envelope,
    version: attestation.record.version,
    fingerprint: attestation.record.fingerprint
  });
}

async function readSources(
  repository: string,
  repositoryKey: string,
  reviewId?: string
): Promise<readonly VerifiedCiReviewSource[]> {
  if (reviewId !== undefined && !/^[0-9a-f]{64}$/.test(reviewId)) return [];
  const root = join(repository, "dim-authoritative-reviews");
  const proposals = join(root, "proposals");
  const staging = join(root, "staging");
  try {
    await Promise.all([root, proposals].map(assertPrivateDirectory));
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  if (reviewId === undefined) {
    await assertPrivateDirectory(staging);
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length !== 2 || entries.some((entry) => !entry.isDirectory()
      || (entry.name !== "proposals" && entry.name !== "staging"))) {
      throw new VerifiedCiReviewSourceError("authoritative native review store layout is invalid");
    }
    await recoverPublishedReviewStaging({ stagingRoot: staging, proposalRoot: proposals });
  }
  const entries = (await readdir(proposals, { withFileTypes: true }))
    .filter(({ name }) => reviewId === undefined || name.startsWith(`${reviewId}.`))
    .sort((left, right) => left.name.localeCompare(right.name));
  const cached = issuedVerifiedCiReviewSources(repositoryKey, reviewId);
  const cachedByName = new Map(cached.map(({ recordName, source }) => [recordName, source]));
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = [...new Set([...entriesByName.keys(), ...cachedByName.keys()])].sort();
  if (names.length > maximumRecords) {
    throw new VerifiedCiReviewSourceError("authoritative native review record capacity is exceeded");
  }
  const verified: VerifiedCiReviewSource[] = [];
  for (const name of names) {
    const cachedSource = cachedByName.get(name);
    if (cachedSource !== undefined) {
      await assertSourceCurrent(repositoryKey, cachedSource);
      verified.push(cachedSource);
      continue;
    }
    const entry = entriesByName.get(name);
    if (entry === undefined) {
      throw new VerifiedCiReviewSourceError("authoritative native review record disappeared during inspection");
    }
    if (!entry.isFile() || recordPattern.exec(entry.name) === null) {
      throw new VerifiedCiReviewSourceError("authoritative native review record name is invalid");
    }
    const path = join(proposals, entry.name);
    const record = await readEnvelopeRecord(path, entry.name);
    verified.push(attestVerifiedCiReviewRecord({
      repositoryKey,
      path,
      recordName: entry.name,
      envelope: record.envelope,
      record: record.record
    }));
  }
  return verified;
}

async function assertSourceCurrent(repositoryKey: string, source: VerifiedCiReviewSource): Promise<void> {
  const proof = verifiedCiReviewSourceProof(source);
  if (proof.repository !== repositoryKey) {
    throw new VerifiedCiReviewSourceError("verified CI review source is bound to another repository scope");
  }
  await Promise.all([
    join(repositoryKey, "dim-authoritative-reviews"),
    join(repositoryKey, "dim-authoritative-reviews", "proposals")
  ].map(assertPrivateDirectory));
  const current = await inspectReviewRecordVersion(proof.path, maximumRecordBytes);
  if (!sameReviewRecordVersion(proof.version, current.version)
    || source.version !== current.fingerprint) {
    throw new VerifiedCiReviewSourceError("attested authoritative native review file version changed");
  }
}

type EnvelopeRecord = {
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly record: VersionedReviewRecord;
};

async function readEnvelopeRecord(path: string, name: string): Promise<EnvelopeRecord> {
  const match = recordPattern.exec(name);
  const record = await readVersionedReviewRecord(path, maximumRecordBytes);
  const envelope = parseAuthoritativeNativeReviewEnvelope(record.value);
  if (match === null || match[1] !== envelope.review.reviewId || match[2] !== envelope.envelopeId) {
    throw new VerifiedCiReviewSourceError("authoritative native review path conflicts with its identity");
  }
  return { envelope, record };
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || uid === undefined
    || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) {
    throw new VerifiedCiReviewSourceError("authoritative native review directory is not private");
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
