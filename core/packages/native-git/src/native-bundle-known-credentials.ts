import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { NativeGitProjectRegistrar } from "./native-project-registrar-http.js";

type Credential = { readonly username: string; readonly password: string };
type CredentialGroup = "root-importers" | "root-read-issuers" | "workspace-write-issuers";

export function nativeBundleKnownCredentials(
  config: NativeGitBundleConfig,
  registrars: readonly NativeGitProjectRegistrar[],
  excludedGroup?: CredentialGroup
): readonly Credential[] {
  return [
    ...registrars,
    ...(excludedGroup === "root-importers" ? [] : config.projectRootImporters),
    ...(excludedGroup === "root-read-issuers" ? [] : config.projectRootReadIssuers),
    ...(excludedGroup === "workspace-write-issuers" ? [] : config.workspaceWriteIssuers),
    ...config.humanReviewers,
    ...config.hostPromoters,
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.candidateReader,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook,
    ...(config.qemuCi === undefined ? [] : [config.qemuCi.query, config.qemuCi.eventIntake, config.qemuCi.identity,
      config.qemuCi.attemptIssuer, config.qemuCi.candidateReader, config.qemuCi.resultReporter])
  ];
}
