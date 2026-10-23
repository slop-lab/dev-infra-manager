import type { PreparedControlPlanePlugin } from "../../packages/control-plane/core/src/plugin-api.js";
import { configuredNativeGitBundleServer, type NativeGitBundleServerOptions } from "../../packages/control-plane/plugins/git-repositories/src/native-bundle-server.js";
import { parseManagedGitServiceConfig, repositoryConfiguration } from "../../packages/control-plane/admin/src/service-pair.js";
import { prepareCodeReview } from "../../packages/control-plane/plugins/git-review/src/index.js";
import { prepareGitCi } from "../../packages/control-plane/plugins/git-ci/src/index.js";
import { controlPlanePlugin as merge } from "../../packages/control-plane/plugins/git-merge-policy/src/index.js";
import { controlPlanePlugin as gitSync } from "../../packages/control-plane/plugins/git-sync/src/index.js";
import { workflowCompilerExtension, type WorkflowCompiler } from "../../packages/contracts/ci/src/workflow-plugin-api.js";
import { dimWorkflowCompiler } from "../../packages/control-plane/plugins/ci-workflows/src/index.js";
import type { CodeReviewService } from "../../packages/control-plane/plugins/git-review/src/plugin-api.js";

export interface ManagedGitFixtureOptions extends Omit<NativeGitBundleServerOptions, "config"> {
  readonly config: unknown;
  readonly workflowCompiler?: WorkflowCompiler;
  readonly executionReadLeaseClock?: () => number;
  readonly authoritativeReviewHooks?: NonNullable<Parameters<typeof prepareCodeReview>[1]>["review"];
  readonly nativeHumanReviewerHooks?: NonNullable<Parameters<typeof prepareCodeReview>[1]>["humanReviewer"];
  readonly ordinaryIdentityHttpClient?: NonNullable<Parameters<typeof prepareGitCi>[1]>["httpClient"];
  readonly deliveryFaults?: NonNullable<Parameters<typeof prepareGitCi>[1]>["deliveryFaults"];
}
/** Explicit full-feature test composition. Individual plugin tests use their owning factories directly. */
export async function configuredManagedGitFixture(options: ManagedGitFixtureOptions) {
  const config = parseManagedGitServiceConfig(options.config);
  const prepared: PreparedControlPlanePlugin[] = [
    prepareCodeReview({ humanReviewers: config.humanReviewers }, {
      ...(options.authoritativeReviewHooks === undefined ? {} : { review: options.authoritativeReviewHooks }),
      ...(options.nativeHumanReviewerHooks === undefined ? {} : { humanReviewer: options.nativeHumanReviewerHooks })
    }),
    prepareGitCi(config.ci, {
      ...(options.executionReadLeaseClock === undefined ? {} : { now: options.executionReadLeaseClock }),
      ...(options.ordinaryIdentityHttpClient === undefined ? {} : { httpClient: options.ordinaryIdentityHttpClient }),
      ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults })
    }),
    await merge.configure({ hostPromoters: config.hostPromoters }),
    await gitSync.configure(config.gitSync ?? { operators: [] })
  ];
  const extensions = [workflowCompilerExtension(config.ci.compiler, options.workflowCompiler ?? dimWorkflowCompiler),
    ...prepared.flatMap((entry) => entry.extensions ?? []), ...(options.extensions ?? [])];
  const service = await configuredNativeGitBundleServer({ ...options, config: repositoryConfiguration(config), extensions });
  const review = extensions.find(({ kind }) => kind === "dim.code-review.service")?.value;
  if (!review || !("create" in review) || typeof review.create !== "function") {
    await service.close(); throw new Error("managed Git fixture has no code review service");
  }
  const create: CodeReviewService["create"] = review.create as CodeReviewService["create"];
  return { ...service, createReview: (selector: Parameters<CodeReviewService["create"]>[1]) => create(service.context, selector) };
}
export type ManagedGitFixture = Awaited<ReturnType<typeof configuredManagedGitFixture>>;
