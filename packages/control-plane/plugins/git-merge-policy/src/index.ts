import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mergePolicyConfigurationSchema } from "./config.js";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { repositoryExtension, readProtectedRefTransition } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { mergeQualityGuards } from "./plugin-api.js";
import { mergeRefUpdatePolicyExtension } from "./ref-update-policy.js";
import { createNativeHostPromoterService } from "./native-host-promoter-http.js";
import { promoteInstalledNativeReview } from "./native-installed-promotion.js";
import { MergeAuthorizationStore } from "./state.js";
export * from "./state.js";
export * from "./native-installed-promotion.js";
export { mergePolicyConfigurationSchema } from "./config.js";
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "merge-policy",
  configure(raw) {
    const config = mergePolicyConfigurationSchema.parse(raw);
    const stores = new Set<MergeAuthorizationStore>();
    const repositoryStores = new Map<string, MergeAuthorizationStore>();
    const refPolicy = mergeRefUpdatePolicyExtension((directory) => repositoryStores.get(directory));
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
      const store = new MergeAuthorizationStore(join(stateDirectory, "authorizations.sqlite3"));
      try {
        // Reconcile only receipts the repository already accepted. Never replay an
        // unsent merge authorization without fresh policy and review checks.
        for (const entry of store.read()) if (entry.sequence === undefined) {
          const receipt = readProtectedRefTransition(context.runtime, entry.authorizationId);
          if (receipt !== undefined) {
            if (receipt.evidenceDigest !== entry.evidenceDigest || receipt.candidateCommit !== entry.authorization.candidateCommit || receipt.candidateTree !== entry.authorization.candidateTree) throw new Error("repository merge receipt conflicts");
            store.finalize(entry.authorizationId, receipt.sequence);
          }
        }
      } catch (error) { store.close(); throw error; }
      stores.add(store); repositoryStores.set(context.stateDirectory, store);
      const http = createNativeHostPromoterService({ promoters: config.hostPromoters, context,
        promote: (projectId, repositoryId, reviewId) => context.mutate({ projectId, repositoryId }, async () => {
          const result = await promoteInstalledNativeReview({ repository: context, store, guards: mergeQualityGuards(context.extensions) }, projectId, repositoryId, reviewId);
          for (const listener of wake) listener(); return result;
        }) });
      return { handle: http.handle, validatePolicy(policy) { z.object({}).strict().parse(policy.extensions["merge-policy"] ?? {}); },
        async close() { repositoryStores.delete(context.stateDirectory); stores.delete(store); store.close(); } };
    } }), { kind: "dim.webhooks.event-source", name: events.name, value: events }], async start() { return { async close() {} }; } };
  }
};
