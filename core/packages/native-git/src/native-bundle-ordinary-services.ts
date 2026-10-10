import type { AuthoritativeNativeReviewController } from "./authoritative-native-review-controller.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { createNativeOrdinaryAttemptService, type NativeOrdinaryAttemptHooks } from "./native-ordinary-attempt-http.js";
import { createNativeOrdinaryStatusService } from "./native-ordinary-status-http.js";
import { createNativeRootCiProofService } from "./native-root-ci-proof-http.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";
import type { OrdinaryReservationClaim } from "./ordinary-reservation-claim.js";

type Credential = { readonly username: string; readonly password: string };
type NativeBundleOrdinaryServicesInput = {
  readonly attemptHooks: NativeOrdinaryAttemptHooks | undefined;
  readonly config: NativeGitBundleConfig;
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: AuthoritativeNativeReviewController["run"];
  readonly verifyClaim: (claim: OrdinaryReservationClaim) => Promise<void>;
};

export function createNativeBundleOrdinaryServices(input: NativeBundleOrdinaryServicesInput) {
  return {
    ordinaryAttemptService: createNativeOrdinaryAttemptService({
      config: input.config,
      knownCredentials: input.knownCredentials,
      runtime: input.runtime,
      serialize: input.serialize,
      verifyClaim: input.verifyClaim,
      ...(input.attemptHooks === undefined ? {} : { hooks: input.attemptHooks })
    }),
    ordinaryStatusService: createNativeOrdinaryStatusService({
      config: input.config,
      httpClient: input.httpClient,
      knownCredentials: input.knownCredentials,
      runtime: input.runtime,
      serialize: input.serialize
    }),
    rootCiProofService: createNativeRootCiProofService({
      credential: input.config.ordinaryCi.identity,
      knownCredentials: input.knownCredentials,
      runtime: input.runtime,
      serialize: input.serialize
    })
  };
}
