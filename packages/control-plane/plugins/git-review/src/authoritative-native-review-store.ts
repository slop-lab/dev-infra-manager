import {
  assertReviewStore,
  maximumRecordBytes,
  readReviewEnvelope,
  readReviewEnvelopes,
  saveReviewEnvelope,
  ReviewStoreError,
} from "@slop-lab/gs-review";
import {
  decodeDimLegacyReviewEnvelope,
  encodeDimLegacyReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope,
} from "@slop-lab/gs-review-contracts/dim-legacy-codec";

export { maximumRecordBytes };
export { ReviewStoreError as AuthoritativeNativeReviewStoreError };
export {
  assertVerifiedCiReviewSourceCurrent,
  readVerifiedCiReviewSources,
  type VerifiedCiReviewSource,
  type VerifiedCiReviewSummary,
} from "@slop-lab/gs-review/dim-legacy-provenance";

export const assertAuthoritativeNativeReviewStore = assertReviewStore;

export async function saveAuthoritativeNativeReviewEnvelope(
  repository: string,
  envelope: AuthoritativeNativeReviewEnvelope,
): Promise<AuthoritativeNativeReviewEnvelope> {
  return encodeDimLegacyReviewEnvelope(await saveReviewEnvelope(
    repository,
    decodeDimLegacyReviewEnvelope(envelope),
  ));
}

export async function readAuthoritativeNativeReviewEnvelope(
  repository: string,
  reviewId: string,
): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  const envelope = await readReviewEnvelope(repository, reviewId);
  return envelope === undefined ? undefined : encodeDimLegacyReviewEnvelope(envelope);
}

export async function readAuthoritativeNativeReviewEnvelopes(
  repository: string,
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  return (await readReviewEnvelopes(repository)).map(encodeDimLegacyReviewEnvelope);
}
