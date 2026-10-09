import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { NativeGitBundleServerOptions } from "./native-bundle-server-types.js";
import { NativeGitBundleServerError } from "./native-bundle-server-types.js";

type RegistrarCredential = {
  readonly hostId: string;
  readonly username: string;
  readonly password: string;
};

export function assertDistinctNativeBundleServerCredentials(
  config: NativeGitBundleConfig,
  registrars: readonly RegistrarCredential[],
  options: Pick<NativeGitBundleServerOptions, "readinessToken" | "activationToken">
): void {
  const serviceCredentialValues = [
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook
  ].flatMap((credential) => [credential.username, credential.password]);
  const registrarCredentialValues = registrars.flatMap((registrar) => [
    registrar.hostId, registrar.username, registrar.password
  ]);
  const protectedCredentialValues = [
    options.readinessToken,
    options.activationToken,
    ...serviceCredentialValues,
    ...registrarCredentialValues,
    ...config.projectRootImporters.flatMap((importer) => [importer.username, importer.password]),
    ...config.projectRootReadIssuers.flatMap((issuer) => [issuer.username, issuer.password]),
    ...config.workspaceWriteIssuers.flatMap((issuer) => [issuer.username, issuer.password])
    , ...config.humanReviewers.flatMap((reviewer) => [reviewer.reviewerId, reviewer.username, reviewer.password])
  ];
  if (new Set(protectedCredentialValues).size !== protectedCredentialValues.length) {
    throw new NativeGitBundleServerError("native Git readiness, activation, and service credentials must be distinct");
  }
}
