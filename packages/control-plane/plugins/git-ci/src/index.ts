import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { CiDeliveryPublicationFaults } from "./delivery-publication.js";
import type { ControlPlanePlugin, PreparedControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, repositoryExtensionKind } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { reviewPreparationExtension, reviewPreparations } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { requireWorkflowCompiler, WORKFLOW_COMPILER_EXTENSION, type WorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";
import { gitCiConfigSchema } from "./config.js";
import { gitCiPreparation } from "./preparation.js";
import { parseGitCiPolicy } from "./policy.js";
import { createExecutionHttpService } from "./execution-http.js";
import { createAuthoritativeNativeEventDispatcher } from "./authoritative-native-event-dispatcher.js";
import { assertGitCiPromotable, type GitCiQualityInput } from "./quality.js";
import type { GitCiRuntime } from "./runtime.js";

export type GitCiOptions = {
  readonly httpClient?: NativeGitAdmissionHttpClient;
  readonly deliveryFaults?: CiDeliveryPublicationFaults;
  readonly now?: () => number;
};
export function prepareGitCi(config: import("./config.js").GitCiConfig, options: GitCiOptions = {}): PreparedControlPlanePlugin {
    let compiler: WorkflowCompiler | undefined;
    let runtime: GitCiRuntime | undefined;
    const preparation = gitCiPreparation(() => {
      if (!compiler) throw new Error("Git CI repository attachment is not ready"); return compiler;
    });
    const feature = repositoryExtension({ name: "git-ci", policyName: "git-ci",
      credentials: [config.grantIssuer, config.candidateReader, config.resultReporter, config.webhook],
      async attach(context) {
        compiler = requireWorkflowCompiler(context.extensions, config.compiler);
        runtime = { ...context.runtime, workflowCompiler: compiler, reviewPreparations: reviewPreparations(context.extensions) };
        const dispatcher = await createAuthoritativeNativeEventDispatcher({ webhook: config.webhook,
          state: runtime.state, stateDirectory: context.stateDirectory, generationId: runtime.expectedGenerationId,
          httpClient: options.httpClient ?? createNodeNativeGitAdmissionHttpClient(), serialize: context.serialize,
          ...(options.deliveryFaults === undefined ? {} : { deliveryFaults: options.deliveryFaults }) });
        const execution = createExecutionHttpService({ config, runtime, stateDirectory: context.stateDirectory, serialize: context.serialize, ...(options.now === undefined ? {} : { now: options.now }) });
        context.signal.addEventListener("abort", () => { void dispatcher.close(); execution.close(); }, { once: true });
        return { handle: execution.handle, serveGit: execution.serveGit,
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
    return { extensions: [feature, reviewPreparationExtension(preparation), {
      kind: "dim.merge-policy.quality-guard", name: "git-ci", value: { name: "git-ci",
        async check(input: GitCiQualityInput) {
          if (!runtime) throw new Error("Git CI repository attachment is unavailable");
          return assertGitCiPromotable(runtime, input);
        }
      }
    }], requiresExtensions: [{ kind: WORKFLOW_COMPILER_EXTENSION, name: config.compiler },
      { kind: repositoryExtensionKind, name: "code-review" }, { kind: "dim.git-repositories.service", name: "default" }],
      async start(context) {
        requireWorkflowCompiler(context.extensions, config.compiler);
        return { async close() {} };
      }
    };
}

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "git-ci",
  configure(raw) { return prepareGitCi(gitCiConfigSchema.parse(raw)); }
};
