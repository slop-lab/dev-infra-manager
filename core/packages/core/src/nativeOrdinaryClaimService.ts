import { isDeepStrictEqual } from "node:util";
import {
  NativeGitAttemptIssuerRejectedError,
  type NativeGitAttemptIssuerClient
} from "./nativeGitAttemptIssuerClient.js";
import {
  NativeAdmissionSourceRejectedError,
  type NativeAdmissionSource
} from "./nativeGitAdmissionSource.js";
import { parseNativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryAuthorityStore } from "./nativeOrdinaryAuthorityStore.js";
import type { NativeHostClaim, NativeHostClaimRequest } from "./nativeOrdinaryClaimProtocol.js";

export type NativeHostClaimResult =
  | { readonly kind: "active"; readonly claim: NativeHostClaim }
  | { readonly kind: "empty" }
  | { readonly kind: "conflict" };

export class NativeOrdinaryClaimService {
  readonly #store: NativeOrdinaryAuthorityStore;
  readonly #issuer: NativeGitAttemptIssuerClient;
  readonly #source: NativeAdmissionSource;

  constructor(store: NativeOrdinaryAuthorityStore, issuer: NativeGitAttemptIssuerClient, source: NativeAdmissionSource) {
    this.#store = store;
    this.#issuer = issuer;
    this.#source = source;
  }

  async claim(request: NativeHostClaimRequest): Promise<NativeHostClaimResult> {
    const reservation = this.#store.reserveClaim(request);
    switch (reservation.kind) {
      case "active":
      case "conflict":
      case "empty":
        return reservation;
      case "preparing":
        break;
      default:
        return assertNever(reservation);
    }
    const context = {
      event: reservation.event,
      admissionGeneration: reservation.admissionGeneration,
      capacity: reservation.capacity
    };
    let descriptor;
    try {
      descriptor = await this.#issuer.loadDescriptor(context);
    } catch (error) {
      if (error instanceof NativeGitAttemptIssuerRejectedError) {
        this.#store.releaseStaleClaim(request, reservation.claimId);
        return { kind: "conflict" };
      }
      throw error;
    }
    let issued;
    try {
      issued = await this.#issuer.issueAttempt({
        issuanceRequestId: reservation.claimId,
        context,
        descriptor
      });
    } catch (error) {
      if (error instanceof NativeGitAttemptIssuerRejectedError) {
        this.#store.releaseStaleClaim(request, reservation.claimId);
        return { kind: "conflict" };
      }
      throw error;
    }
    const requestedAssignment = parseNativeAttemptAssignment({
      schemaVersion: 1,
      reviewId: issued.issuance.reviewId,
      attemptId: issued.issuance.attemptId,
      descriptor: issued.issuance.descriptor,
      descriptorDigest: issued.issuance.descriptorDigest,
      admissionGeneration: reservation.admissionGeneration,
      hostId: issued.issuance.hostId,
      capacity: issued.issuance.capacity
    });
    let provenAssignment;
    try {
      provenAssignment = parseNativeAttemptAssignment(
        await this.#source.assertIssuedAttempt(requestedAssignment)
      );
    } catch (error) {
      if (!(error instanceof NativeAdmissionSourceRejectedError)) throw error;
      await this.#issuer.revokeAttempt(issued.issuance);
      this.#store.releaseStaleClaim(request, reservation.claimId);
      return { kind: "conflict" };
    }
    if (!isDeepStrictEqual(provenAssignment, requestedAssignment)) {
      await this.#issuer.revokeAttempt(issued.issuance);
      this.#store.releaseStaleClaim(request, reservation.claimId);
      return { kind: "conflict" };
    }
    const activated = this.#store.activateClaim(request, reservation, {
      assignment: provenAssignment,
      issuance: issued.issuance
    });
    switch (activated.kind) {
      case "active":
        return activated;
      case "conflict":
        await this.#issuer.revokeAttempt(issued.issuance);
        this.#store.releaseStaleClaim(request, reservation.claimId);
        return activated;
      default:
        return assertNever(activated);
    }
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected native claim state: ${JSON.stringify(value)}`);
}
