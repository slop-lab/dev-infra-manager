import { join } from "node:path";
import type { ControlPlanePluginEntry } from "@slop-lab/dim-control-plane-core";
import { controlPlanePlugin as repositories } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { controlPlanePlugin as review } from "@slop-lab/dim-control-plane-plugin-code-review";
import { controlPlanePlugin as merge } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { controlPlanePlugin as gitCi } from "@slop-lab/dim-control-plane-plugin-git-ci";
import { controlPlanePlugin as workflows } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { controlPlanePlugin as webhooks } from "@slop-lab/dim-control-plane-plugin-webhooks";
import { parseManagedGitServiceConfig, repositoryConfiguration } from "@slop-lab/dim-control-plane-admin/service-pair";

/** The managed image is one explicit preset, separate from independently installed plugins. */
export function managedGitPluginEntries(input: {
  readonly config: unknown;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
}): readonly ControlPlanePluginEntry[] {
  const config = parseManagedGitServiceConfig(input.config);
  return [
    { plugin: workflows, config: {} },
    { plugin: review, config: { humanReviewers: config.humanReviewers } },
    { plugin: gitCi, config: config.ci },
    { plugin: merge, config: { hostPromoters: config.hostPromoters } },
    { plugin: repositories, config: { service: repositoryConfiguration(config), stateDirectory: input.stateDirectory,
      readinessToken: input.readinessToken, activationToken: input.activationToken,
      expectedGenerationId: input.expectedGenerationId } },
    ...(config.webhooks === undefined ? [] : [{ plugin: webhooks, config: {
      ...webhookOptions(config.webhooks), stateDirectory: join(input.stateDirectory, ".extensions", "webhooks"),
      generationId: input.expectedGenerationId
    } }])
  ];
}
function webhookOptions(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("managed webhook configuration must be an object");
  return Object.fromEntries(Object.entries(input));
}
