import { expect, it } from "vitest";
import { createAuthoritativeNativeReviewDeliveryProjection, createAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";
import { projectionDigestInput } from "./projectionDigestFixture.js";

it("retains the approved ff4 review, CI envelope and event digest domains", () => {
  // Given IDs independently captured from the unmodified ff4 source archive.
  const expected = {
    reviewId: "1b7740b3322ad4432eb0da1e33b603e6e036c82d8e785c4328d0ab247b38b060",
    envelopeId: "64bca941669615e1c6ccb7cdd4d6fe0c084f8ed13162b0f8cb77c341bbded537",
    eventIds: ["bc95a2e10f10506eb9abf9eb1d2023750ea0a59cbde6fab12ffb4f61fe80eb8c"]
  };
  // When full construction and compact derivation consume the same identity.
  const full = createAuthoritativeNativeReviewEnvelope(projectionDigestInput);
  const compact = createAuthoritativeNativeReviewDeliveryProjection({ ...projectionDigestInput, review: full.review });
  // Then neither sharing the derivation nor excluding patches changes persisted IDs.
  expect({ reviewId: full.review.reviewId, envelopeId: full.envelopeId, eventIds: full.events.map(({ eventId }) => eventId) }).toEqual(expected);
  expect({ reviewId: compact.reviewId, envelopeId: compact.envelopeId, eventIds: compact.events.map(({ eventId }) => eventId) }).toEqual(expected);
});
