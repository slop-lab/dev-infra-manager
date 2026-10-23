import type { ExampleRecipe } from "../../../scripts/examples/recipe.ts";
import { configuredNativeGitBundleServer } from "../../../packages/control-plane/plugins/git-repositories/src/native-bundle-server.js";
import { repositoryConfiguration, parseManagedGitServiceConfig } from "../../../packages/control-plane/admin/src/service-pair.js";
import { controlPlanePlugin as reviewPlugin } from "../../../packages/control-plane/plugins/git-review/src/index.js";
import { controlPlanePlugin as gitCiPlugin } from "../../../packages/control-plane/plugins/git-ci/src/index.js";
import { controlPlanePlugin as mergePlugin } from "../../../packages/control-plane/plugins/git-merge-policy/src/index.js";
import { controlPlanePlugin as workflowPlugin } from "../../../packages/control-plane/plugins/ci-workflows/src/index.js";
import type { CodeReviewService } from "../../../packages/control-plane/plugins/git-review/src/plugin-api.js";
import { idleNativeConfig } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { activationToken, finalizeReadinessToken, generationId, importer, humanReviewer, hostPromoter,
  workspaceWriteIssuer } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
const services: { close(): Promise<void> }[] = [];
export async function closeExampleServices() { await Promise.all(services.splice(0).map((service) => service.close())); }
/** Source integration composes precisely the recipe's repository-side plugins.
 * The independent coordinator and host plugins are installed/executed by the VM stage. */
export async function startExampleService(recipe: ExampleRecipe, root: string) {
  const config = parseManagedGitServiceConfig({ ...idleNativeConfig(), projectRootImporters: [importer],
    workspaceWriteIssuers: [workspaceWriteIssuer], humanReviewers: [humanReviewer], hostPromoters: [hostPromoter] });
  const options = { config, stateDirectory: root, readinessToken: finalizeReadinessToken, activationToken, expectedGenerationId: generationId };
  const selected = new Set(recipe.plugins.controlPlane.map((specifier) => specifier.slice(0, specifier.lastIndexOf("@"))));
  const registry = [
    { plugin: reviewPlugin, config: { humanReviewers: config.humanReviewers } },
    { plugin: gitCiPlugin, config: config.ci },
    { plugin: mergePlugin, config: { hostPromoters: config.hostPromoters } },
    { plugin: workflowPlugin, config: {} }
  ];
  const entries = registry.filter(({ plugin }) => selected.has(`@slop-lab/dim-control-plane-plugin-${plugin.name}`));
  if (!selected.has("@slop-lab/dim-control-plane-plugin-git-repositories")) throw new Error("example does not declare its Git repository service");
  const prepared = await Promise.all(entries.filter(({ plugin }) => plugin.name !== "git-repositories")
    .map(({ plugin, config }) => plugin.configure(config)));
  const extensions = prepared.flatMap((entry) => entry.extensions ?? []);
  const service = await configuredNativeGitBundleServer({ ...options, config: repositoryConfiguration(config), extensions });
  try {
    const origin = await service.listen("127.0.0.1", 0);
    const review = extensions.find(({ kind }) => kind === "dim.code-review.service")?.value;
    if (!review || !("create" in review) || typeof review.create !== "function") throw new Error("example does not declare code review");
    const create = (review as CodeReviewService).create;
    const running = { ...service, origin, createReview: (selector: Parameters<CodeReviewService["create"]>[1]) => create(service.context, selector) };
    services.push(running); return running;
  } catch (error) { await service.close(); throw error; }
}
