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
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook
  ];
}
