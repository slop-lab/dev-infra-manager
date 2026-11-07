import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { authoritativeNativeDeliveryBinding, gitCiEnvelope, parseGitCiPolicy,
  readVerifiedGitCiDeliveryProjection, recordExplicitAuthoritativeNativeDeliveryIntent,
  type CiDeliveryPublicationFaults } from "@slop-lab/gs-ci";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { readNativeProjectRegistrations, repositoryExtension, repositoryExtensionKind,
  resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { readVerifiedCiReviewSources, reviewPreparationExtension,
  reviewPreparations } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { requireWorkflowCompiler, WORKFLOW_COMPILER_EXTENSION } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";
import type { WorkflowCompiler } from "@slop-lab/gs-ci-contracts";
import { dimReviewJobAvailableEventCodec } from "@slop-lab/dim-contracts-ci/execution";
import { gitCiConfigSchema } from "./config.js";
import { gitCiPreparation } from "./preparation.js";
import { createExecutionHttpService } from "./execution-http.js";
import { createAuthoritativeNativeEventDispatcher } from "./authoritative-native-event-dispatcher.js";
import { assertGitCiPromotable, gitCiQualityRevision, type GitCiQualityInput } from "./quality.js";
import { gitCiRefUpdatePolicyExtension } from "./ref-update-policy.js";
import { toGsReviewEnvelope } from "./review-adapter.js";
import type { GitCiRuntime } from "./runtime.js";
import { handleReviewCiStatus } from "./review-status-http.js";
import { handleWorkspaceCandidateCi } from "./workspace-candidate-http.js";
import { join } from "node:path";
import { createExecutionServiceQueryClient } from "@slop-lab/dim-service-client-execution";

export type GitCiOptions = {
  readonly httpClient?: NativeGitAdmissionHttpClient;
  readonly deliveryFaults?: CiDeliveryPublicationFaults;
  readonly now?: () => number;
  readonly workflowCompiler?: WorkflowCompiler;
};
export function prepareGitCi(config: import("./config.js").GitCiConfig, options: GitCiOptions = {}): PreparedControlPlanePlugin {
    let compiler: WorkflowCompiler | undefined = options.workflowCompiler;
    let runtime: GitCiRuntime | undefined;
    const binding = authoritativeNativeDeliveryBinding("ci", config.webhook.endpoint, dimReviewJobAvailableEventCodec);
    const preparation = gitCiPreparation(() => {
      if (!compiler) throw new Error("Git CI repository attachment is not ready"); return compiler;
    }, async ({ runtime: base, envelope, ownerRequestId }) => {
      if (!runtime) throw new Error("Git CI repository attachment is unavailable");
      const requestRuntime = { ...base, authoritativeTargetProofs: base.authoritativeTargetProofs ?? new Map() };
      const target = await resolveAuthoritativeNativeRepositoryTarget(requestRuntime, { projectId: envelope.review.projectId,
        repositoryId: envelope.review.repositoryId, protectedRef: envelope.review.protectedRef });
      const planned = await gitCiEnvelope(target.repository, toGsReviewEnvelope(envelope));
      if (planned !== undefined) await recordExplicitAuthoritativeNativeDeliveryIntent(target.repository, planned,
        runtime.expectedGenerationId, binding, ownerRequestId);
    }, config.compiler);
    const refUpdatePolicy = gitCiRefUpdatePolicyExtension(config.compiler);
    const feature = repositoryExtension({ name: "git-ci", policyName: "git-ci",
      requiresRefUpdatePolicies: ["git-ci"],
      credentials: [config.grantIssuer, config.candidateReader, config.resultReporter, config.webhook, ...(config.query ? [config.query] : [])],
      async attach(context) {
        compiler = requireWorkflowCompiler(context.extensions, config.compiler);
        runtime = { ...context.runtime, workflowCompiler: compiler, reviewPreparations: reviewPreparations(context.extensions) };
        const query = config.query === undefined ? undefined : createExecutionServiceQueryClient({ schemaVersion: 1,
          role: "query", endpoint: new URL(config.webhook.endpoint).origin,
          generationId: runtime.expectedGenerationId, credential: config.query });
        for (const registration of readNativeProjectRegistrations(runtime.state)) {
          const repository = join(context.stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
          for (const source of await readVerifiedCiReviewSources(repository)) {
            await readVerifiedGitCiDeliveryProjection(repository, source);
          }
        }
        const dispatcher = await createAuthoritativeNativeEventDispatcher({ webhook: config.webhook,
          state: runtime.state, stateDirectory: context.stateDirectory, generationId: runtime.expectedGenerationId,
          httpClient: options.httpClient ?? createNodeNativeGitAdmissionHttpClient(), serialize: context.serialize,
          ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults }) });
        const execution = createExecutionHttpService({ config, runtime, stateDirectory: context.stateDirectory,
          mutate: context.mutate, read: context.read, signal: context.signal,
          ...(options.now === undefined ? {} : { now: options.now }) });
        context.signal.addEventListener("abort", () => { dispatcher.stop(); execution.close(); }, { once: true });
        const attachedRuntime = runtime;
        return { async handle(request, response, url) {
          if (await handleWorkspaceCandidateCi(context, attachedRuntime, { request, response, url, accepted: dispatcher.wake },
            query)) return true;
          if (await handleReviewCiStatus(context, attachedRuntime, { request, response, url })) return true;
          return execution.handle(request, response, url);
        }, serveGit: execution.serveGit,
          async onProposals() { dispatcher.wake(); },
          validatePolicy(policy, selector) {
            const selected = policy.extensions["git-ci"];
            if (selected !== undefined) parseGitCiPolicy(selected, selector.repositoryId);
          },
          async activate() { dispatcher.start(); }, healthy: dispatcher.healthy,
          async close() { execution.close(); await dispatcher.close(); }
        };
      }
    });
    return { extensions: [refUpdatePolicy, feature, { kind: "dim.git-repositories.feature", name: "git-ci", value: { version: 1 } }, reviewPreparationExtension(preparation), {
      kind: "dim.merge-policy.quality-guard", name: "git-ci", value: { name: "git-ci", revision: gitCiQualityRevision,
        async check(input: GitCiQualityInput) {
          if (!runtime) throw new Error("Git CI repository attachment is unavailable");
          return assertGitCiPromotable(runtime, input);
        }
      }
    }], requiresExtensions: [{ kind: WORKFLOW_COMPILER_EXTENSION, name: config.compiler },
      { kind: repositoryExtensionKind, name: "code-review" }, { kind: "dim.git-repositories.service", name: "default" }],
      async start(context) {
        compiler = requireWorkflowCompiler(context.extensions, config.compiler);
        return { async close() {} };
      }
    };
}

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "git-ci",
  configure(raw) { return prepareGitCi(gitCiConfigSchema.parse(raw)); }
};
