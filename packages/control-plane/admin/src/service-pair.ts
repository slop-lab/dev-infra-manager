import { z } from "zod";
import { parseCodeReviewConfig } from "@slop-lab/dim-control-plane-plugin-code-review/config";
import { mergePolicyConfigurationSchema } from "@slop-lab/dim-control-plane-plugin-merge-policy/config";
import { gitCiConfigSchema } from "@slop-lab/dim-control-plane-plugin-git-ci/config";
import { parseNativeGitBundleConfig } from "@slop-lab/dim-control-plane-plugin-git-repositories/config";
import { executionServiceConfigSchema } from "@slop-lab/dim-control-plane-plugin-execution-scheduler/config";
export function parseControlPlaneServicePair(nativeValue: unknown, executionValue: unknown) {
  const native = parseManagedGitServiceConfig(nativeValue), parsed = executionServiceConfigSchema.safeParse(executionValue);
  if (!parsed.success) throw new Error("invalid execution scheduler configuration");
  const execution = parsed.data;
  if (execution.nativeGit === undefined || execution.nativeGit.endpoint !== "http://native-git:8080") throw new Error("paired CI deployment requires its private native Git endpoint");
  const roles = ["grantIssuer", "candidateReader", "resultReporter"] as const;
  for (const role of roles) assertPair(native.ci[role], execution.nativeGit[role]);
  if (execution.credentials.query === undefined) throw new Error("paired Git CI deployment requires a query credential");
  if (execution.credentials.webhook === undefined) throw new Error("paired Git CI deployment requires a webhook credential");
  assertPair(native.ci.webhook, execution.credentials.webhook);
  const credentials = [...native.projectRegistrars, ...native.projectRootImporters, ...native.projectRootReadIssuers,
    ...native.workspaceWriteIssuers, ...native.humanReviewers, ...native.hostPromoters,
    ...gitCiCredentials(native.ci), execution.credentials.query, execution.credentials.operator,
    ...(execution.credentials.tasks === undefined ? [] : [execution.credentials.tasks]),
    ...execution.workers.map((worker) => ({ username: worker.id, password: worker.token }))];
  const values = credentials.flatMap((entry) => [entry.username, entry.password]);
  if (new Set(values).size !== values.length) throw new Error("control-plane credentials must be distinct");
  return { native, execution };
}
function assertPair(left: { username: string; password: string }, right: { username: string; password: string }): void {
  if (left.username !== right.username || left.password !== right.password) throw new Error("control-plane paired credentials do not match");
}

/** The managed preset selects features explicitly; repositories themselves have no such dependencies. */
export function parseManagedGitServiceConfig(value: unknown) {
  const object = z.record(z.string(), z.unknown()).parse(value);
  const { humanReviewers, hostPromoters, ci, webhooks, ...repositoryInput } = object;
  const repository = parseNativeGitBundleConfig(repositoryInput);
  const review = parseCodeReviewConfig({ humanReviewers });
  const merge = mergePolicyConfigurationSchema.parse({ hostPromoters });
  const integration = gitCiConfigSchema.parse(ci);
  const credentials = [...repository.projectRegistrars, ...repository.projectRootImporters,
    ...repository.projectRootReadIssuers, ...repository.workspaceWriteIssuers,
    ...review.humanReviewers, ...merge.hostPromoters, ...gitCiCredentials(integration)];
  const values = credentials.flatMap((entry) => [entry.username, entry.password]);
  if (new Set(values).size !== values.length) throw new Error("managed Git credentials must be globally distinct");
  return { ...repository, ...review, ...merge, ci: integration,
    ...(webhooks === undefined ? {} : { webhooks }) };
}
export function repositoryConfiguration(config: ReturnType<typeof parseManagedGitServiceConfig>) {
  const { humanReviewers: _reviewers, hostPromoters: _promoters, ci: _ci, webhooks: _webhooks, ...repository } = config;
  return repository;
}
export function gitCiCredentials(config: ReturnType<typeof gitCiConfigSchema.parse>) {
  return [config.grantIssuer, config.candidateReader, config.resultReporter, config.webhook];
}
