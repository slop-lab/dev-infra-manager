import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mergePolicyConfigurationSchema } from "./config.js";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { mergeRefUpdatePolicyExtension } from "./ref-update-policy.js";
import { createNativeHostPromoterService } from "./native-host-promoter-http.js";
import { MergeAuthorizationStore } from "./state.js";
import { createDimGsMergeRuntime, type DimGsMergeRuntime } from "./gs-merge-runtime.js";
export * from "./state.js";
export * from "./native-installed-promotion.js";
export { mergePolicyConfigurationSchema } from "./config.js";
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "merge-policy",
  configure(raw) {
    const config = mergePolicyConfigurationSchema.parse(raw);
    const stores = new Set<MergeAuthorizationStore>();
    const runtimes = new Map<string, DimGsMergeRuntime>();
    const runtimeFor = (context: import("@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api").RepositoryExtensionContext): DimGsMergeRuntime => {
      const runtime = runtimes.get(context.stateDirectory);
      if (runtime === undefined) throw new Error("GS merge policy runtime is unavailable");
      return runtime;
    };
    const refPolicy = mergeRefUpdatePolicyExtension(runtimeFor);
    const wake = new Set<() => void>();
    const events = { name: "merge-policy", async read() {
      return [...stores].flatMap((store) => store.read().flatMap(({ authorization: value, authorizationId, sequence }) => sequence === undefined ? [] : [{
        identity: authorizationId, type: "dev.dim.git.ref.promoted", projectId: value.projectId,
        subject: `projects/${value.projectId}/repositories/${value.repositoryId}`,
        data: { projectId: value.projectId, repositoryId: value.repositoryId, reviewId: value.reviewId,
          authorizationId, sequence, protectedRef: value.protectedRef, expectedCommit: value.expectedCommit,
          candidateCommit: value.candidateCommit, candidateTree: value.candidateTree, generationId: value.generationId }
      }]));
    }, subscribeWake(listener: () => void) { wake.add(listener); return () => { wake.delete(listener); }; } };
    return { requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.code-review.service", name: "default" }],
      extensions: [refPolicy, repositoryExtension({ name: "merge-policy", policyName: "merge-policy", requiresRefUpdatePolicies: ["merge-policy"], credentials: config.hostPromoters, async attach(context) {
      const stateDirectory = context.extensionStateDirectory;
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const runtime = createDimGsMergeRuntime(context, { statePath: join(stateDirectory, "authorizations.sqlite3") });
      const store = runtime.feature.authorizationStore;
      try {
        await runtime.feature.recover(runtime.review.adapter.authority);
      } catch (error) { await runtime.service.close(); throw error; }
      stores.add(store); runtimes.set(context.stateDirectory, runtime);
      const http = createNativeHostPromoterService({ promoters: config.hostPromoters, context,
        promote: async (projectId, repositoryId, reviewId) => {
          const result = await runtime.service.promote({ namespaceId: projectId, repositoryId, reviewId });
          for (const listener of wake) listener(); return result;
        } });
      return { handle: http.handle, validatePolicy(policy) { z.object({}).strict().parse(policy.extensions["merge-policy"] ?? {}); },
        async close() { runtimes.delete(context.stateDirectory); stores.delete(store); await runtime.service.close(); } };
    } }), { kind: "dim.webhooks.event-source", name: events.name, value: events }], async start() { return { async close() {} }; } };
  }
};
