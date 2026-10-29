import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { mergePolicyConfigurationSchema } from "./config.js";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  readNativeProjectRootImportsFromDatabase,
  readProtectedRefTransition,
  repositoryExtension,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
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
    const adapterRevision = createHash("sha256").update("dim-gs-merge-ref-policy-adapter-v1").digest("hex");
    const runtimeFor = (context: import("@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api").RepositoryExtensionContext): DimGsMergeRuntime => {
      const runtime = runtimes.get(context.stateDirectory);
      if (runtime === undefined) throw new Error("GS merge policy runtime is unavailable");
      return runtime;
    };
    const refPolicy = mergeRefUpdatePolicyExtension(
      runtimeFor,
      () => runtimes.values().next().value?.feature.refUpdatePolicy.revision ?? adapterRevision,
    );
    const wake = new Set<() => void>();
    const events = { name: "merge-policy", async read() {
      return [...stores].flatMap((store) => store.read().flatMap(({ authorization: value, authorizationId, sequence }) => sequence === undefined ? [] : [{
        identity: authorizationId, type: "dev.dim.git.ref.promoted", projectId: value.namespaceId,
        subject: `projects/${value.namespaceId}/repositories/${value.repositoryId}`,
        data: { projectId: value.namespaceId, repositoryId: value.repositoryId, reviewId: value.reviewId,
          authorizationId, sequence, protectedRef: value.protectedRef, expectedCommit: value.expectedCommit,
          candidateCommit: value.candidateCommit, candidateTree: value.candidateTree, generationId: value.authorityEpoch }
      }]));
    }, subscribeWake(listener: () => void) { wake.add(listener); return () => { wake.delete(listener); }; } };
    return { requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.code-review.service", name: "default" }],
      extensions: [refPolicy, repositoryExtension({ name: "merge-policy", policyName: "merge-policy", requiresRefUpdatePolicies: ["merge-policy"], credentials: config.hostPromoters, async attach(context) {
      const stateDirectory = context.extensionStateDirectory;
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const runtime = createDimGsMergeRuntime(context, { statePath: join(stateDirectory, "authorizations.sqlite3") });
      const store = runtime.feature.authorizationStore;
      try {
        backfillLegacyRecoveryProofs(context, store);
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

function backfillLegacyRecoveryProofs(
  context: RepositoryExtensionContext,
  store: MergeAuthorizationStore,
): void {
  const imports = readNativeProjectRootImportsFromDatabase(context.runtime.state.database);
  for (const entry of store.read()) {
    if (entry.sequence !== undefined || entry.recoveryProof !== undefined) continue;
    const transition = readProtectedRefTransition(context.runtime, entry.authorizationId);
    if (transition === undefined) continue;
    const authorization = entry.authorization;
    const imported = imports.find((candidate) => candidate.phase === "repository-imported"
      && candidate.projectId === transition.projectId && candidate.repositoryId === transition.repositoryId
      && candidate.importNonce === transition.importNonce);
    if (imported === undefined || transition.projectId !== authorization.namespaceId
      || transition.repositoryId !== authorization.repositoryId
      || transition.authorizationId !== entry.authorizationId || transition.evidenceDigest !== entry.evidenceDigest
      || transition.generationId !== authorization.authorityEpoch
      || transition.policyDigest !== authorization.policyDigest
      || transition.protectedRef !== authorization.protectedRef || transition.proposalRef !== authorization.proposalRef
      || transition.expectedCommit !== authorization.expectedCommit
      || transition.candidateCommit !== authorization.candidateCommit
      || transition.candidateTree !== authorization.candidateTree) {
      throw new Error("legacy repository merge receipt conflicts with its authorization");
    }
    store.backfillRecoveryProof(entry.authorizationId, {
      expectedTree: transition.expectedTree,
      incarnationId: transition.importNonce,
      authorityEpoch: transition.generationId,
      ownerPrincipalId: imported.ownerHostId,
      refPolicyRevision: transition.refPolicyRevision,
    });
  }
}
