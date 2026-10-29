import type {
  AuthoritativeNativeReview,
  AuthoritativeNativeReviewEnvelope,
} from "@slop-lab/gs-review-contracts";
import type { ReviewRecordVersion } from "./review-record-version.js";
import { sameReviewRecordVersion } from "./review-record-version.js";

export type VerifiedCiReviewSummary = {
  readonly schemaVersion: 3;
  readonly envelopeId: string;
  readonly review: Omit<AuthoritativeNativeReview, "changes" | "patch" | "patchBytes">;
  readonly policyDigest: string;
  readonly attachments: AuthoritativeNativeReviewEnvelope["attachments"];
};

export type VerifiedCiReviewSource = {
  readonly summary: VerifiedCiReviewSummary;
  readonly version: string;
};

export type VerifiedCiReviewSourceProof = {
  readonly repository: string;
  readonly path: string;
  readonly recordName: string;
  readonly version: ReviewRecordVersion;
};

type IssueVerifiedCiReviewSource = VerifiedCiReviewSourceProof & {
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly fingerprint: string;
};

const proofs = new WeakMap<VerifiedCiReviewSource, VerifiedCiReviewSourceProof>();
const sources = new Map<string, Map<string, VerifiedCiReviewSource>>();
const maximumIssuedRepositories = 4_096;
const maximumIssuedSources = 100_000;
const maximumCompactSourceBytes = 1024 * 1024;
const maximumIssuedSourceBytes = 64 * 1024 * 1024;
const proofOverheadBytes = 256;
let issuedSourceCount = 0;
let issuedSourceBytes = 0;

export function issueVerifiedCiReviewSource(input: IssueVerifiedCiReviewSource): VerifiedCiReviewSource {
  const existing = sources.get(input.repository)?.get(input.recordName);
  if (existing !== undefined) {
    const proof = proofs.get(existing);
    if (proof === undefined || !sameReviewRecordVersion(proof.version, input.version)) {
      throw new VerifiedCiReviewSourceError("attested authoritative native review file version changed");
    }
    return existing;
  }
  const { changes: _changes, patch: _patch, patchBytes: _patchBytes, ...review } = input.envelope.review;
  const summary = structuredClone({
    schemaVersion: input.envelope.schemaVersion,
    envelopeId: input.envelope.envelopeId,
    review,
    policyDigest: input.envelope.policyDigest,
    attachments: input.envelope.attachments,
  } satisfies VerifiedCiReviewSummary);
  freezeValue(summary);
  const source: VerifiedCiReviewSource = Object.freeze({ summary, version: input.fingerprint });
  const sourceBytes = Buffer.byteLength(JSON.stringify(source), "utf8")
    + Buffer.byteLength(`${input.repository}\0${input.path}\0${input.recordName}`, "utf8")
    + proofOverheadBytes;
  const repositorySources = sources.get(input.repository);
  if (sourceBytes > maximumCompactSourceBytes || issuedSourceCount >= maximumIssuedSources
    || issuedSourceBytes + sourceBytes > maximumIssuedSourceBytes
    || (repositorySources === undefined && sources.size >= maximumIssuedRepositories)) {
    throw new VerifiedCiReviewSourceError("verified CI review source capacity is exhausted");
  }
  proofs.set(source, {
    repository: input.repository,
    path: input.path,
    recordName: input.recordName,
    version: input.version,
  });
  const targetSources = repositorySources ?? new Map<string, VerifiedCiReviewSource>();
  targetSources.set(input.recordName, source);
  sources.set(input.repository, targetSources);
  issuedSourceCount += 1;
  issuedSourceBytes += sourceBytes;
  return source;
}

export function verifiedCiReviewSourceProof(source: VerifiedCiReviewSource): VerifiedCiReviewSourceProof {
  const proof = proofs.get(source);
  if (proof === undefined) throw new VerifiedCiReviewSourceError("verified CI review source is not a process-issued capability");
  return proof;
}

export function issuedVerifiedCiReviewSources(
  repository: string,
  reviewId?: string,
): readonly { readonly recordName: string; readonly source: VerifiedCiReviewSource }[] {
  const repositorySources = sources.get(repository);
  if (repositorySources === undefined) return [];
  return [...repositorySources.entries()]
    .filter(([recordName]) => reviewId === undefined || recordName.startsWith(`${reviewId}.`))
    .map(([recordName, source]) => ({ recordName, source }));
}

function freezeValue(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeValue(nested);
  Object.freeze(value);
}

export class VerifiedCiReviewSourceError extends Error {
  readonly name = "VerifiedCiReviewSourceError";
}
