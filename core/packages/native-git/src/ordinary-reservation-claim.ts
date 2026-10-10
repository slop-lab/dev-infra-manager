import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { authoritativeNativeReviewEventSchema } from "./authoritative-native-review-schema.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { ordinaryExecutionDescriptorRequestFields } from "./candidate-execution-schema.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hexDigest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const assignmentIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

const ordinaryReviewEventSchema = authoritativeNativeReviewEventSchema.unwrap().extend({
  executionKind: z.literal("ordinary-sysbox")
}).strict().readonly();

export const ordinaryReservationClaimSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("ordinary-main"),
  generationId: hexDigest,
  serviceEpochId: uuidV4,
  requestId: uuidV4,
  claimId: uuidV4,
  issuanceRequestId: uuidV4,
  demandId: uuidV4,
  admissionGeneration: uuidV4,
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  event: ordinaryReviewEventSchema,
  admission: z.object({
    projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    repositoryId: z.literal("root"),
    importNonce: uuidV4,
    rootSequence: z.number().int().nonnegative(),
    protectedRef: z.string().startsWith("refs/heads/"),
    rootCommit: objectId,
    rootTree: objectId,
    policyDigest: hexDigest,
    capacityConfigDigest: hexDigest,
    leaseExpiresAt: z.number().int().positive()
  }).strict().readonly(),
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  runnerBaseImage: ordinaryExecutionDescriptorRequestFields.runnerBaseImage,
  jobBaseImage: ordinaryExecutionDescriptorRequestFields.jobBaseImage,
  bounds: ordinaryExecutionDescriptorRequestFields.bounds
}).strict().readonly().superRefine((claim, context) => {
  if (claim.issuanceRequestId !== claim.claimId) {
    context.addIssue({ code: "custom", path: ["issuanceRequestId"], message: "must equal claimId" });
  }
  if (claim.admission.projectId !== claim.event.projectId
    || claim.admission.repositoryId !== claim.event.repositoryId
    || claim.admission.protectedRef !== claim.event.protectedRef
    || claim.admission.rootCommit !== claim.event.expectedProtectedHead
    || claim.admission.rootTree.length !== claim.admission.rootCommit.length) {
    context.addIssue({ code: "custom", path: ["admission"], message: "must match event root identity" });
  }
});

export type OrdinaryReservationClaim = z.infer<typeof ordinaryReservationClaimSchema>;

type ClaimVerifier = {
  readonly verify: (claim: OrdinaryReservationClaim) => Promise<void>;
};

export function createOrdinaryReservationClaimVerifier(input: {
  readonly config: NativeGitBundleConfig["ordinaryCi"];
  readonly generationId: string;
  readonly httpClient: AdmissionVerifierHttpClient;
}): ClaimVerifier {
  const authorization = `Basic ${Buffer.from(
    `${input.config.query.username}:${input.config.query.password}`, "utf8"
  ).toString("base64")}`;
  return {
    async verify(claim) {
      const requestId = randomUUID();
      let response;
      try {
        response = await input.httpClient.request({
          endpoint: input.config.endpoint,
          method: "POST",
          path: "/v1/claim-reservation-verifications",
          authorization,
          body: JSON.stringify({ schemaVersion: 1, requestId, generationId: input.generationId, claim }),
          signal: AbortSignal.timeout(requestTimeoutMilliseconds)
        });
      } catch (error) {
        throw new OrdinaryReservationClaimUnavailableError({ cause: error });
      }
      if (response.statusCode === 404 || response.statusCode === 409) {
        throw new OrdinaryReservationClaimRejectedError(response.statusCode);
      }
      if (response.statusCode !== 200 || response.contentType !== "application/json"
        || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
        throw new OrdinaryReservationClaimUnavailableError();
      }
      let body: unknown;
      try {
        body = JSON.parse(response.body.toString("utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) throw new OrdinaryReservationClaimUnavailableError({ cause: error });
        throw error;
      }
      const expected = { schemaVersion: 1, serviceId: input.config.serviceId, requestId,
        claimId: claim.claimId, issuanceRequestId: claim.issuanceRequestId, authorized: true } as const;
      if (!isDeepStrictEqual(body, expected)) throw new OrdinaryReservationClaimUnavailableError();
    }
  };
}

export class OrdinaryReservationClaimRejectedError extends Error {
  readonly name = "OrdinaryReservationClaimRejectedError";
  constructor(readonly statusCode: 404 | 409) { super("ordinary reservation claim is not current"); }
}

export class OrdinaryReservationClaimUnavailableError extends Error {
  readonly name = "OrdinaryReservationClaimUnavailableError";
  constructor(options?: ErrorOptions) { super("ordinary reservation claim verification is unavailable", options); }
}
