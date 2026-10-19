import { parseNativeGitBundleConfig } from "@slop-lab/dim-plugin-control-plane-native-git/config";
import { executionServiceConfigSchema } from "./ci/config.js";
export function parseControlPlaneServicePair(nativeValue: unknown, ciValue: unknown) {
  const native = parseNativeGitBundleConfig(nativeValue), parsed = executionServiceConfigSchema.safeParse(ciValue);
  if (!parsed.success) throw new Error("invalid CI service configuration");
  const ordinary = parsed.data;
  const roles = ["grantIssuer", "candidateReader", "resultReporter"] as const;
  for (const role of roles) assertPair(native.ci[role], ordinary.nativeGit[role]);
  assertPair(native.ci.webhook, ordinary.credentials.webhook);
  const credentials = [...native.projectRegistrars, ...native.projectRootImporters, ...native.projectRootReadIssuers,
    ...native.workspaceWriteIssuers, ...native.humanReviewers, ...native.hostPromoters,
    ...Object.values(native.ci), ordinary.credentials.query, ordinary.credentials.operator,
    ...ordinary.workers.map((worker) => ({ username: worker.id, password: worker.token }))];
  const values = credentials.flatMap((entry) => [entry.username, entry.password]);
  if (new Set(values).size !== values.length) throw new Error("control-plane credentials must be distinct");
  return { native, ordinary };
}
function assertPair(left: { username: string; password: string }, right: { username: string; password: string }): void {
  if (left.username !== right.username || left.password !== right.password) throw new Error("control-plane paired credentials do not match");
}
