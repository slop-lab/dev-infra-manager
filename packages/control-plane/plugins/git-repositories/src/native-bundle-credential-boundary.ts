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
  const registrarCredentialValues = registrars.flatMap((registrar) => [
    registrar.username, registrar.password
  ]);
  const protectedCredentialValues = [
    options.readinessToken,
    options.activationToken,
    ...registrarCredentialValues,
    ...config.projectRootImporters.flatMap((importer) => [importer.username, importer.password]),
    ...config.projectRootReadIssuers.flatMap((issuer) => [issuer.username, issuer.password]),
    ...config.workspaceWriteIssuers.flatMap((issuer) => [issuer.username, issuer.password])
  ];
  const scopeIds = [...config.projectRegistrars, ...config.projectRootImporters, ...config.projectRootReadIssuers,
    ...config.workspaceWriteIssuers].map((entry) => entry.hostId);
  if (new Set(protectedCredentialValues).size !== protectedCredentialValues.length
    || scopeIds.includes(options.readinessToken) || scopeIds.includes(options.activationToken)) {
    throw new NativeGitBundleServerError("native Git readiness, activation, and service credentials must be distinct");
  }
}
